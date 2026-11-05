// Use case: aplicar hardening a un dispositivo en PT.
// (Port of application/use_cases/apply_hardening.py)

import { HardeningConfig, LocalUser, SSHConfig } from "../../domain/models/hardening.js";
import { PlanError, ErrorCode } from "../../domain/models/errors.js";
import {
    validate_hardening, validate_hardening_against_topology,
} from "../../domain/rules/hardening_rules.js";
import {
    generate_hardening_cli, build_hardening_payload, build_hardening_js_call,
} from "../../infrastructure/generator/hardening_cli_generator.js";
import { pyStr, pyTruthy } from "../../shared/pycompat.js";

// Python f"{exc}" stringifies an exception to its message only.
function _exc_str(exc) {
    return exc instanceof Error ? exc.message : pyStr(exc);
}

export function build_hardening_config(
    device, hostname = "", banner_motd = "", enable_secret = "",
    users = null, ssh = null,
    service_password_encryption = true
) {
    return new HardeningConfig({
        device: device, hostname: hostname, banner_motd: banner_motd, enable_secret: enable_secret,
        users: (pyTruthy(users) ? users : []).map((u) => new LocalUser(u)),
        ssh: pyTruthy(ssh) ? new SSHConfig(ssh) : null,
        service_password_encryption: service_password_encryption,
    });
}

export function apply_hardening_uc(cfg, query_pt_topology = null, bridge_send = null, dry_run = false) {
    const res = validate_hardening(cfg);
    const errors = [...res.errors];
    const warnings = [...res.warnings];
    if (query_pt_topology !== null && query_pt_topology !== undefined) {
        try {
            const devices_in_pt = query_pt_topology();
            const tr = validate_hardening_against_topology(cfg, devices_in_pt);
            errors.push(...tr.errors);
            warnings.push(...tr.warnings);
        } catch (exc) {  // pragma: no cover
            warnings.push(new PlanError({
                code: ErrorCode.VALIDATION_ERROR,
                message: `Could not validate against PT: ${_exc_str(exc)}`,
            }));
        }
    }
    const cli_lines = generate_hardening_cli(cfg);
    const js_call = build_hardening_js_call(cfg.device, build_hardening_payload(cfg));
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
