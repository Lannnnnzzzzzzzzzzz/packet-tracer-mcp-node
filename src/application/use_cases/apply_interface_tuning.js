// Use case: aplicar ajuste fino de interfaz a un router en PT.
// (Port of application/use_cases/apply_interface_tuning.py)

import { PlanError, ErrorCode } from "../../domain/models/errors.js";
import {
    validate_interface_tuning, validate_interface_tuning_against_topology,
} from "../../domain/rules/interface_tuning_rules.js";
import {
    generate_interface_tuning_cli, build_interface_tuning_payload,
    build_interface_tuning_js_call,
} from "../../infrastructure/generator/interface_tuning_cli_generator.js";
import { pyStr } from "../../shared/pycompat.js";

// Python f"{exc}" stringifies an exception to its message only.
function _exc_str(exc) {
    return exc instanceof Error ? exc.message : pyStr(exc);
}

export function apply_interface_tuning_uc(cfg, query_pt_topology = null, bridge_send = null, dry_run = false) {
    const res = validate_interface_tuning(cfg);
    const errors = [...res.errors];
    const warnings = [...res.warnings];
    if (query_pt_topology !== null && query_pt_topology !== undefined) {
        try {
            const devices_in_pt = query_pt_topology();
            const tr = validate_interface_tuning_against_topology(cfg, devices_in_pt);
            errors.push(...tr.errors);
            warnings.push(...tr.warnings);
        } catch (exc) {  // pragma: no cover
            warnings.push(new PlanError({
                code: ErrorCode.VALIDATION_ERROR,
                message: `Could not validate against PT: ${_exc_str(exc)}`,
            }));
        }
    }
    const cli_lines = generate_interface_tuning_cli(cfg);
    const js_call = build_interface_tuning_js_call(
        cfg.router, build_interface_tuning_payload(cfg), cfg.changes_ospf());
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
