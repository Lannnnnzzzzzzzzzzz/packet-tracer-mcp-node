// Use case: apply an ACL to a router in the active topology.
//
// Pipeline:
//   1. Builds ACLPlan + optional ACLBinding from user-friendly args.
//   2. Validates statically (ranges, types, IPs/wildcards, unreachable rules).
//   3. Checks against the active PT topology (router and interface exist).
//   4. Generates IOS CLI and builds the payload for configureIosDevice.
//   5. Returns a payload ready to send via the bridge (or sends it if apply=True).
//
// The actual application is delegated to the caller (MCP tool) to keep this
// module free of HTTP bridge dependencies.
//
// (Port of application/use_cases/apply_acl.py)

import { ACLPlan, ACLEntry, ACLBinding } from "../../domain/models/acls.js";
import { PlanError, ErrorCode, ValidationResult } from "../../domain/models/errors.js";
import { validate_acl_plan, validate_acl_binding } from "../../domain/rules/acl_rules.js";
import { has_control_chars } from "../../domain/rules/text_rules.js";
import {
    build_configure_payload,
    build_remove_payload,
    generate_acl_cli,
    generate_acl_binding_cli,
} from "../../infrastructure/generator/acl_cli_generator.js";
import { resolve_model } from "../../infrastructure/catalog/devices.js";
import { pyJsonDumps, pyStr } from "../../shared/pycompat.js";

// Python f"{exc}" stringifies an exception to its message only.
function _exc_str(exc) {
    return exc instanceof Error ? exc.message : pyStr(exc);
}

export function build_acl_plan(router, name_or_number, acl_type, entries_dicts) {
    /** Builds an ACLPlan from dicts (typically from the LLM). */
    const entries = entries_dicts.map((e) => new ACLEntry(e));
    return new ACLPlan({
        router: router,
        name_or_number: pyStr(name_or_number),
        acl_type: acl_type,
        entries: entries,
    });
}

export function validate_against_topology(plan, binding, devices_in_pt) {
    /** Checks that the router (and its interface, if there is a binding) exist in PT.
     *
     * `devices_in_pt` is the raw output of the bridge (queryTopology()):
     * each dict has at least {name, type, model}. It does not include explicit
     * interfaces, so the interface check is heuristic:
     * if the router's model is in the catalog, we validate against its
     * known ports.
     */
    const errors = [];
    const warnings = [];

    const device = devices_in_pt.find((d) => d["name"] === plan.router) ?? null;
    if (device === null) {
        errors.push(new PlanError({
            code: ErrorCode.ACL_ROUTER_NOT_FOUND,
            device: plan.router,
            message: `Router '${plan.router}' does not exist in PT's active topology.`,
            suggestion: "Call pt_query_topology to see the available devices.",
        }));
        return new ValidationResult({ errors: errors, warnings: warnings });
    }

    if (binding !== null && binding !== undefined) {
        // Checks the interface against the catalog (best-effort).
        // Accepts sub-interfaces (e.g. "GigabitEthernet0/0/1.20") as long as the base port
        // exists — PT creates sub-interfaces dynamically when configuring dot1Q.
        // (Python imports resolve_model here, inside the function.)
        const model = resolve_model(device["model"] ?? "");
        if (model !== null && model !== undefined) {
            const valid_ports = new Set(model.ports.map((p) => p.full_name));
            const iface = binding.interface;
            const base_iface = iface.split(".")[0];
            if (!valid_ports.has(iface) && !valid_ports.has(base_iface)) {
                errors.push(new PlanError({
                    code: ErrorCode.ACL_INTERFACE_NOT_FOUND,
                    device: plan.router,
                    message: `Interface '${binding.interface}' does not exist on ${pyStr(device["model"] === undefined ? null : device["model"])}.`,
                    suggestion: `Available ports: ${[...valid_ports].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(", ")} (.N subinterfaces are valid if the base port exists)`,
                }));
            }
        }
    }

    return new ValidationResult({ errors: errors, warnings: warnings });
}

export function apply_acl_uc(plan, binding = null, query_pt_topology = null, bridge_send = null, dry_run = false) {
    /** Full pipeline: validate + (optionally) apply.
     *
     * Args:
     *     plan: ACLPlan already built.
     *     binding: optional, applies the ACL to an interface.
     *     query_pt_topology: callable that returns devices_in_pt (list of dicts).
     *         If None, the PT check is skipped (static validation only).
     *     bridge_send: callable that receives the full JS payload and sends it to PT.
     *         If None or dry_run=True, nothing is sent.
     *     dry_run: if True, returns the payload without sending it.
     *
     * Returns:
     *     dict with keys: valid, errors, warnings, cli_lines, js_payload, sent.
     */
    // 1. Static validation of the plan
    const plan_result = validate_acl_plan(plan);
    const errors = [...plan_result.errors];
    const warnings = [...plan_result.warnings];

    // 2. Validate the binding (if applicable)
    if (binding !== null && binding !== undefined) {
        const binding_result = validate_acl_binding(binding, plan);
        errors.push(...binding_result.errors);
        warnings.push(...binding_result.warnings);
    }

    // 3. Dynamic validation against PT
    if (query_pt_topology !== null && query_pt_topology !== undefined) {
        try {
            const devices_in_pt = query_pt_topology();
            const topo_result = validate_against_topology(plan, binding, devices_in_pt);
            errors.push(...topo_result.errors);
            warnings.push(...topo_result.warnings);
        } catch (exc) {
            warnings.push(new PlanError({
                code: ErrorCode.VALIDATION_ERROR,
                device: plan.router,
                message: `Could not query the active topology: ${_exc_str(exc)}. Static validation applied.`,
            }));
        }
    }

    // 4. Always generate the CLI (useful for inspection even if there are errors)
    const cli_lines = generate_acl_cli(plan);
    if (binding !== null && binding !== undefined) {
        cli_lines.push(...generate_acl_binding_cli(binding));
    }

    const full_payload = build_configure_payload(plan, binding);
    const js_call = _build_js_call(plan.router, full_payload);

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

export function remove_acl_uc(router, name_or_number, binding_interface = "", direction = "in", bridge_send = null, dry_run = false) {
    /** Builds and sends commands to remove an applied ACL. */
    // ACLPlan is not used, so validate_acl_plan does not run, but the same fields
    // end up raw in the CLI (`no access-list {name}`, `interface {iface}`).
    const errors = [];
    for (const [label, value] of [
        ["name_or_number", pyStr(name_or_number)],
        ["binding_interface", binding_interface],
        ["direction", direction],
    ]) {
        if (has_control_chars(value)) {
            errors.push(new PlanError({
                code: ErrorCode.ACL_INVALID_NAME,
                device: router,
                message: `${label} contains a line break.`,
                suggestion: `Use a single-line value in ${label}.`,
            }));
        }
    }

    const payload = build_remove_payload(router, pyStr(name_or_number), binding_interface, direction);
    const js_call = _build_js_call(router, payload);

    let sent = false;
    if (!errors.length && !dry_run && bridge_send !== null && bridge_send !== undefined) {
        sent = Boolean(bridge_send(js_call));
    }

    return {
        "valid": !errors.length,
        "errors": errors.map((e) => e.toDict()),
        "router": router,
        "acl_id": pyStr(name_or_number),
        "js_payload": js_call,
        "sent": sent,
        "dry_run": dry_run,
    };
}

export function _build_js_call(router, ios_payload) {
    /** Wraps the IOS payload in a configureIosDevice call as a single JS line.
     *
     * Important: the full string must go on one line of JS code (without
     * real line breaks in the code), but the \\n INSIDE the string do survive
     * because they are string-literal escapes — they are not source-code line breaks
     * that executeCode() would strip.
     */
    // json.dumps per value: it also escapes \r, U+2028/2029 and control
    // characters, which the old hand-written escaping let through.
    return `configureIosDevice(${pyJsonDumps(router)}, ${pyJsonDumps(ios_payload)});`;
}
