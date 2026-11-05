// Use cases: aplicar STP y port-security a un switch en PT.
// (Port of application/use_cases/apply_switch_security.py)

import { PlanError, ErrorCode } from "../../domain/models/errors.js";
import {
    validate_stp, validate_stp_against_topology,
    validate_port_security, validate_port_security_against_topology,
} from "../../domain/rules/switch_security_rules.js";
import {
    generate_stp_cli, generate_port_security_cli,
    build_stp_payload, build_port_security_payload, build_switch_js_call,
} from "../../infrastructure/generator/switch_security_cli_generator.js";
import { pyStr } from "../../shared/pycompat.js";

// Python f"{exc}" stringifies an exception to its message only.
function _exc_str(exc) {
    return exc instanceof Error ? exc.message : pyStr(exc);
}

export function _run(cfg, static_validate, topo_validate, gen_cli, build_payload, device,
                     query_pt_topology, bridge_send, dry_run) {
    const res = static_validate(cfg);
    const errors = [...res.errors];
    const warnings = [...res.warnings];
    if (query_pt_topology !== null && query_pt_topology !== undefined) {
        try {
            const devices_in_pt = query_pt_topology();
            const tr = topo_validate(cfg, devices_in_pt);
            errors.push(...tr.errors);
            warnings.push(...tr.warnings);
        } catch (exc) {  // pragma: no cover
            warnings.push(new PlanError({
                code: ErrorCode.VALIDATION_ERROR,
                message: `Could not validate against PT: ${_exc_str(exc)}`,
            }));
        }
    }
    const cli_lines = gen_cli(cfg);
    const js_call = build_switch_js_call(device, build_payload(cfg));
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

export function apply_stp_uc(cfg, query_pt_topology = null, bridge_send = null, dry_run = false) {
    return _run(cfg, validate_stp, validate_stp_against_topology,
                generate_stp_cli, build_stp_payload, cfg.switch,
                query_pt_topology, bridge_send, dry_run);
}

export function apply_port_security_uc(cfg, query_pt_topology = null, bridge_send = null, dry_run = false) {
    return _run(cfg, validate_port_security, validate_port_security_against_topology,
                generate_port_security_cli, build_port_security_payload, cfg.switch,
                query_pt_topology, bridge_send, dry_run);
}
