// Use case: apply NAT/PAT to a router in the active topology.
//
// Pipeline (identical to the ACL one):
//   1. Builds NATConfig from user-friendly args.
//   2. Validates statically (IPs, interfaces, pool, inside networks).
//   3. Checks against the active PT topology (router and interfaces exist).
//   4. Generates IOS CLI and builds the payload for configureIosDevice.
//   5. Sends via the bridge or returns a dry-run payload.
//
// (Port of application/use_cases/apply_nat.py)

import { NATConfig, NATPool, NATStaticMapping } from "../../domain/models/nat.js";
import { PlanError, ErrorCode, ValidationResult } from "../../domain/models/errors.js";
import { validate_nat_config, validate_nat_against_topology } from "../../domain/rules/nat_rules.js";
import { has_control_chars } from "../../domain/rules/text_rules.js";
import {
    build_nat_configure_payload,
    build_nat_remove_payload,
    build_nat_js_call,
    generate_nat_interface_cli,
    generate_nat_body_cli,
} from "../../infrastructure/generator/nat_cli_generator.js";
import { pyStr, pyTruthy } from "../../shared/pycompat.js";

// Python f"{exc}" stringifies an exception to its message only.
function _exc_str(exc) {
    return exc instanceof Error ? exc.message : pyStr(exc);
}

export function build_nat_config(
    router,
    mode,
    inside_interface,
    outside_interface,
    static_mappings = null,
    inside_networks = null,
    acl_number = "1",
    pool_name = "NAT-POOL",
    pool_start = "",
    pool_end = "",
    pool_netmask = "",
    use_interface_overload = false
) {
    /** Builds a NATConfig from flat parameters (typically from the LLM). */
    const mappings = (pyTruthy(static_mappings) ? static_mappings : []).map((m) => new NATStaticMapping(m));

    let pool = null;
    if (pool_start && pool_end && pool_netmask) {
        pool = new NATPool({
            name: pool_name,
            start_ip: pool_start,
            end_ip: pool_end,
            netmask: pool_netmask,
        });
    }

    return new NATConfig({
        router: router,
        mode: mode,
        inside_interface: inside_interface,
        outside_interface: outside_interface,
        static_mappings: mappings,
        inside_networks: pyTruthy(inside_networks) ? inside_networks : [],
        acl_number: acl_number,
        pool: pool,
        use_interface_overload: use_interface_overload,
    });
}

export function apply_nat_uc(config, query_pt_topology = null, bridge_send = null, dry_run = false) {
    /** Full pipeline: validate + (optionally) apply NAT.
     *
     * Args:
     *     config: NATConfig already built.
     *     query_pt_topology: callable → list of devices in PT. If None, skips the
     *         dynamic check.
     *     bridge_send: callable that receives the JS payload and sends it. If None
     *         or dry_run=True, nothing is sent.
     *     dry_run: if True, returns the payload without sending it.
     *
     * Returns:
     *     dict with keys: valid, errors, warnings, cli_lines, js_payload, sent, dry_run.
     */
    // 1. Static validation
    const result = validate_nat_config(config);
    const errors = [...result.errors];
    const warnings = [...result.warnings];

    // 2. Dynamic validation against PT
    if (query_pt_topology !== null && query_pt_topology !== undefined) {
        try {
            const devices_in_pt = query_pt_topology();
            const topo_result = validate_nat_against_topology(config, devices_in_pt);
            errors.push(...topo_result.errors);
            warnings.push(...topo_result.warnings);
        } catch (exc) {
            warnings.push(new PlanError({
                code: ErrorCode.VALIDATION_ERROR,
                device: config.router,
                message: `Could not query the active topology: ${_exc_str(exc)}. Static validation applied.`,
            }));
        }
    }

    // 3. Always generate the CLI (useful for inspection even if there are errors)
    const cli_lines = generate_nat_interface_cli(config);
    cli_lines.push(...generate_nat_body_cli(config));

    const full_payload = build_nat_configure_payload(config);
    const js_call = build_nat_js_call(config.router, full_payload);

    let sent = false;
    if (!errors.length && !dry_run && bridge_send !== null && bridge_send !== undefined) {
        sent = Boolean(bridge_send(js_call));
    }

    return {
        "valid": errors.length === 0,
        "errors": errors.map((e) => e.toDict()),
        "warnings": warnings.map((w) => w.toDict()),
        "cli_lines": cli_lines,
        "js_payload": js_call,
        "sent": sent,
        "dry_run": dry_run,
    };
}

export function remove_nat_uc(
    router,
    mode,
    inside_interface,
    outside_interface,
    acl_number = "1",
    pool_name = "",
    static_mappings = null,
    bridge_send = null,
    dry_run = false
) {
    /** Builds and sends commands to remove NAT/PAT from a router. */
    // NATConfig is not used, so validate_nat_config does not run, but the same fields
    // end up raw in the CLI (`no ip nat pool {pool_name}`, ...).
    const fields = [
        ["mode", mode],
        ["inside_interface", inside_interface],
        ["outside_interface", outside_interface],
        ["acl_number", acl_number],
        ["pool_name", pool_name],
    ];
    (pyTruthy(static_mappings) ? static_mappings : []).forEach((m, i) => {
        for (const [k, v] of Object.entries(m)) {
            fields.push([`static_mappings[${i}].${k}`, pyStr(v)]);
        }
    });
    const errors = [];
    for (const [label, value] of fields) {
        if (has_control_chars(value)) {
            errors.push(new PlanError({
                code: ErrorCode.NAT_INVALID_NAME,
                device: router,
                message: `${label} contains a line break.`,
                suggestion: `Use a single-line value in ${label}.`,
            }));
        }
    }

    const payload = build_nat_remove_payload(
        router,
        mode,
        inside_interface,
        outside_interface,
        acl_number,
        pool_name,
        static_mappings,
    );
    const js_call = build_nat_js_call(router, payload);

    let sent = false;
    if (!errors.length && !dry_run && bridge_send !== null && bridge_send !== undefined) {
        sent = Boolean(bridge_send(js_call));
    }

    return {
        "valid": !errors.length,
        "errors": errors.map((e) => e.toDict()),
        "router": router,
        "mode": mode,
        "js_payload": js_call,
        "sent": sent,
        "dry_run": dry_run,
    };
}
