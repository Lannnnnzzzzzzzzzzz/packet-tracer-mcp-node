// Use case: apply VLAN / trunk / inter-VLAN to an active PT topology.
// (Port of application/use_cases/apply_vlan.py)

import {
    VLANPlan, VLANConfig, AccessPortConfig, TrunkConfig, SubinterfaceConfig,
} from "../../domain/models/vlans.js";
import { PlanError, ErrorCode } from "../../domain/models/errors.js";
import {
    validate_vlan_plan, validate_vlan_against_topology,
} from "../../domain/rules/vlan_rules.js";
import {
    generate_switch_vlan_cli, generate_router_subinterface_cli,
    build_switch_vlan_payload, build_router_subinterface_payload,
    build_vlan_js_call, switch_supports_encap,
} from "../../infrastructure/generator/vlan_cli_generator.js";
import { pyStr, pyTruthy } from "../../shared/pycompat.js";

// Python f"{exc}" stringifies an exception to its message only.
function _exc_str(exc) {
    return exc instanceof Error ? exc.message : pyStr(exc);
}

export function _coerce(cls, items) {
    const out = [];
    for (const it of pyTruthy(items) ? items : []) {
        out.push(it instanceof cls ? it : new cls(it));
    }
    return out;
}

// NOTE: the Python parameter is named `switch`, a reserved word in JS, so it
// is spelled `switch_` here; positional callers are unaffected.
export function build_vlan_plan(
    switch_ = "", router = "",
    vlans = null, access_ports = null, trunks = null, subinterfaces = null
) {
    return new VLANPlan({
        switch: switch_, router: router,
        vlans: _coerce(VLANConfig, vlans),
        access_ports: _coerce(AccessPortConfig, access_ports),
        trunks: _coerce(TrunkConfig, trunks),
        subinterfaces: _coerce(SubinterfaceConfig, subinterfaces),
    });
}

export function apply_vlan_uc(
    plan,
    query_pt_topology = null,
    bridge_send = null,
    dry_run = false,
    switch_model = ""
) {
    /** Validates + (optionally) applies VLANs/trunks to the switch and subinterfaces to the router. */
    const plan_result = validate_vlan_plan(plan);
    const errors = [...plan_result.errors];
    const warnings = [...plan_result.warnings];

    let supports_encap = switch_supports_encap(switch_model);
    if (query_pt_topology !== null && query_pt_topology !== undefined) {
        try {
            const devices_in_pt = query_pt_topology();
            if (!switch_model) {
                for (const d of devices_in_pt) {
                    if (d["name"] === plan.switch) {
                        supports_encap = switch_supports_encap(d["model"] ?? "");
                        break;
                    }
                }
            }
            const topo = validate_vlan_against_topology(plan, devices_in_pt);
            errors.push(...topo.errors);
            warnings.push(...topo.warnings);
        } catch (exc) {  // pragma: no cover - defensive
            warnings.push(new PlanError({
                code: ErrorCode.VALIDATION_ERROR,
                message: `Could not validate against PT: ${_exc_str(exc)}`,
            }));
        }
    }

    const cli_lines = [];
    const js_calls = [];

    if (pyTruthy(plan.switch) && (pyTruthy(plan.vlans) || pyTruthy(plan.access_ports) || pyTruthy(plan.trunks))) {
        cli_lines.push(
            ...generate_switch_vlan_cli(plan.vlans, plan.access_ports, plan.trunks, supports_encap)
        );
        const payload = build_switch_vlan_payload(
            plan.vlans, plan.access_ports, plan.trunks, supports_encap
        );
        js_calls.push(build_vlan_js_call(plan.switch, payload));
    }

    if (pyTruthy(plan.router) && pyTruthy(plan.subinterfaces)) {
        cli_lines.push(...generate_router_subinterface_cli(plan.subinterfaces));
        const payload = build_router_subinterface_payload(plan.subinterfaces);
        js_calls.push(build_vlan_js_call(plan.router, payload));
    }

    let sent = false;
    if (!errors.length && !dry_run && bridge_send !== null && bridge_send !== undefined && pyTruthy(js_calls)) {
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
