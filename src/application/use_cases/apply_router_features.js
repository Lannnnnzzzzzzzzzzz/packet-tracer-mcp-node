// Use cases: apply HSRP, BGP and QoS to a router in PT.
// (Port of application/use_cases/apply_router_features.py)

import {
    HsrpConfig, BgpConfig, BgpNeighbor, QosConfig, QosClass,
} from "../../domain/models/router_features.js";
import { PlanError, ErrorCode } from "../../domain/models/errors.js";
import {
    validate_hsrp, validate_hsrp_against_topology,
    validate_bgp, validate_bgp_against_topology,
    validate_qos, validate_qos_against_topology,
} from "../../domain/rules/router_feature_rules.js";
import {
    generate_hsrp_cli, generate_bgp_cli, generate_qos_cli,
    wrap_ios_payload, build_ios_js_call,
} from "../../infrastructure/generator/router_feature_cli_generator.js";
import { pyStr, pyTruthy } from "../../shared/pycompat.js";

// Python f"{exc}" stringifies an exception to its message only.
function _exc_str(exc) {
    return exc instanceof Error ? exc.message : pyStr(exc);
}

export function build_bgp_config(router, asn, neighbors = null, networks = null) {
    /** Raises ValueError (pydantic's ValidationError) on a malformed neighbor. */
    return new BgpConfig({
        router: router, asn: asn,
        neighbors: (pyTruthy(neighbors) ? neighbors : []).map((n) => new BgpNeighbor(n)),
        networks: [...(pyTruthy(networks) ? networks : [])],
    });
}

export function build_qos_config(router, interface_, policy_name, classes = null, direction = "output") {
    /** Raises ValueError (pydantic's ValidationError) on a malformed class. */
    return new QosConfig({
        router: router, interface: interface_, policy_name: policy_name,
        classes: (pyTruthy(classes) ? classes : []).map((c) => new QosClass(c)), direction: direction,
    });
}

export function run_ios_feature(cfg, device, static_validate, topo_validate, gen_cli,
                                query_pt_topology, bridge_send, dry_run) {
    /** Validate (statically, then against PT when it answers), render and maybe send. */
    const res = static_validate(cfg);
    const errors = [...res.errors];
    const warnings = [...res.warnings];
    if (query_pt_topology !== null && query_pt_topology !== undefined) {
        try {
            const tr = topo_validate(cfg, query_pt_topology());
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
    const js_call = build_ios_js_call(device, wrap_ios_payload(cli_lines));
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

export function apply_hsrp_uc(cfg, query_pt_topology = null, bridge_send = null, dry_run = false) {
    return run_ios_feature(cfg, cfg.router, validate_hsrp, validate_hsrp_against_topology,
                           generate_hsrp_cli, query_pt_topology, bridge_send, dry_run);
}

export function apply_bgp_uc(cfg, query_pt_topology = null, bridge_send = null, dry_run = false) {
    return run_ios_feature(cfg, cfg.router, validate_bgp, validate_bgp_against_topology,
                           generate_bgp_cli, query_pt_topology, bridge_send, dry_run);
}

export function apply_qos_uc(cfg, query_pt_topology = null, bridge_send = null, dry_run = false) {
    return run_ios_feature(cfg, cfg.router, validate_qos, validate_qos_against_topology,
                           generate_qos_cli, query_pt_topology, bridge_send, dry_run);
}
