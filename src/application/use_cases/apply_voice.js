// Use case: Cisco CME voice on a router (+ optional voice VLAN on a switch) in PT.
// (Port of application/use_cases/apply_voice.py)

import { VoiceConfig, VoiceExtension } from "../../domain/models/voice.js";
import { PlanError, ErrorCode } from "../../domain/models/errors.js";
import { validate_voice, validate_voice_against_topology } from "../../domain/rules/voice_rules.js";
import {
    wrap_ios_payload, build_ios_js_call,
} from "../../infrastructure/generator/router_feature_cli_generator.js";
import {
    generate_voice_router_cli, generate_voice_switch_cli,
} from "../../infrastructure/generator/voice_cli_generator.js";
import { pyStr, pyTruthy } from "../../shared/pycompat.js";

// Python f"{exc}" stringifies an exception to its message only.
function _exc_str(exc) {
    return exc instanceof Error ? exc.message : pyStr(exc);
}

export function build_voice_config(router, source_ip, extensions = null, kwargs = {}) {
    /** Raises ValueError (pydantic's ValidationError) on a malformed extension.
     *
     * An extension is {"number": "1001", "mac"?: "0001.4321.ABCD"} or a bare "1001".
     */
    const exts = [];
    for (const e of pyTruthy(extensions) ? extensions : []) {
        exts.push((typeof e === "string" || typeof e === "number")
            ? new VoiceExtension({ number: pyStr(e) })
            : new VoiceExtension(e));
    }
    const { access_ports = null, ...rest } = kwargs;
    return new VoiceConfig({
        router: router, source_ip: source_ip, extensions: exts,
        access_ports: [...(pyTruthy(access_ports) ? access_ports : [])], ...rest,
    });
}

export function apply_voice_uc(cfg, query_pt_topology = null, bridge_send = null, dry_run = false) {
    /** Validate (statically, then against PT when it answers), render and maybe send.
     *
     * The router gets CME (+ DHCP option 150); the switch, when given, its voice VLAN.
     * Each device is one verified payload.
     */
    const res = validate_voice(cfg);
    const errors = [...res.errors];
    const warnings = [...res.warnings];
    if (query_pt_topology !== null && query_pt_topology !== undefined) {
        try {
            const tr = validate_voice_against_topology(cfg, query_pt_topology());
            errors.push(...tr.errors);
            warnings.push(...tr.warnings);
        } catch (exc) {  // pragma: no cover
            warnings.push(new PlanError({
                code: ErrorCode.VALIDATION_ERROR,
                message: `Could not validate against PT: ${_exc_str(exc)}`,
            }));
        }
    } else {
        warnings.push(new PlanError({
            code: ErrorCode.VOICE_UNSUPPORTED_ROUTER, device: cfg.router,
            message: "PT is not connected: the router model was not checked "
                    + "(CME only works on a 2811).",
            suggestion: "Connect PT and run again before relying on this config.",
        }));
    }

    const router_lines = generate_voice_router_cli(cfg);
    const js_calls = [build_ios_js_call(cfg.router, wrap_ios_payload(router_lines))];
    const cli_lines = [...router_lines];
    const switch_lines = generate_voice_switch_cli(cfg);
    if (pyTruthy(switch_lines)) {
        js_calls.push(build_ios_js_call(pyTruthy(cfg.switch) ? cfg.switch : "", wrap_ios_payload(switch_lines)));
        cli_lines.push(`! --- ${cfg.switch} ---`, ...switch_lines);
    }

    let sent = false;
    if (!errors.length && !dry_run && bridge_send !== null && bridge_send !== undefined) {
        sent = js_calls.every((j) => Boolean(bridge_send(j)));
    }
    return {
        "valid": errors.length === 0,
        "errors": errors.map((e) => e.toDict()),
        "warnings": warnings.map((w) => w.toDict()),
        "cli_lines": cli_lines,
        "js_payload": js_calls.join(""),
        "sent": sent,
        "dry_run": dry_run,
    };
}
