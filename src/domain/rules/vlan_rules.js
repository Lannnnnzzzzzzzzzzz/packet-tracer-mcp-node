// Static and topology-level validation of a VLANPlan.

import { PlanError, ErrorCode, ValidationResult } from "../models/errors.js";
import { resolve_model } from "../../infrastructure/catalog/devices.js";
import { has_control_chars } from "./text_rules.js";

export function validate_vlan_plan(plan) {
    /** Validates a VLANPlan without touching PT (ranges, duplicates, consistency). */
    const errors = [];
    const warnings = [];

    const seen = new Set();
    for (const v of plan.vlans) {
        if (!(1 <= v.vlan_id && v.vlan_id <= 4094)) {
            errors.push(new PlanError({
                code: ErrorCode.VLAN_INVALID_ID,
                device: plan.switch || plan.router,
                message: `VLAN id ${v.vlan_id} out of range (1-4094).`,
                suggestion: "Use an id between 1 and 4094 (avoid the reserved 1002-1005).",
            }));
        }
        if (v.name && has_control_chars(v.name)) {
            errors.push(new PlanError({
                code: ErrorCode.VLAN_INVALID_NAME,
                device: plan.switch || plan.router,
                message: `The name of VLAN ${v.vlan_id} contains a line break.`,
                suggestion: "Use a single-line VLAN name.",
            }));
        }
        if (seen.has(v.vlan_id)) {
            errors.push(new PlanError({
                code: ErrorCode.VLAN_DUPLICATE_ID,
                device: plan.switch || plan.router,
                message: `VLAN id ${v.vlan_id} duplicada.`,
                suggestion: "Each VLAN must be declared only once.",
            }));
        }
        seen.add(v.vlan_id);
    }

    const declared = new Set(plan.vlans.map((v) => v.vlan_id));
    for (const ap of plan.access_ports) {
        if (declared.size && !declared.has(ap.vlan_id)) {
            warnings.push(new PlanError({
                code: ErrorCode.VLAN_INVALID_ID,
                device: ap.switch,
                message: `Port ${ap.port} assigned to undeclared VLAN ${ap.vlan_id}.`,
                suggestion: "Declare the VLAN in `vlans` or use an existing one.",
            }));
        }
    }

    for (const t of plan.trunks) {
        if (!(1 <= t.native_vlan && t.native_vlan <= 4094)) {
            errors.push(new PlanError({
                code: ErrorCode.VLAN_INVALID_ID,
                device: t.switch,
                message: `Native VLAN ${t.native_vlan} out of range.`,
                suggestion: "Use a valid native VLAN (default 1).",
            }));
        }
    }

    for (const s of plan.subinterfaces) {
        if (declared.size && !declared.has(s.vlan_id)) {
            warnings.push(new PlanError({
                code: ErrorCode.VLAN_INVALID_ID,
                device: s.router,
                message: `Subinterface ${s.parent_port}.${s.vlan_id} for an undeclared VLAN.`,
                suggestion: "The subinterface must match an access VLAN on the switch.",
            }));
        }
    }

    return new ValidationResult({ errors: errors, warnings: warnings });
}

export function validate_vlan_against_topology(plan, devices_in_pt) {
    /** Checks that the switch/router (and its ports) exist in PT's active topology. */
    const errors = [];
    const warnings = [];

    const by_name = {};
    for (const d of devices_in_pt) by_name[d["name"]] = d;

    function _ports_of(dev_name) {
        const dev = by_name[dev_name];
        if (!dev) {
            return new Set();
        }
        const model = resolve_model(dev["model"] ?? "");
        if (model === null || model === undefined) {
            return new Set();
        }
        return new Set(model.ports.map((p) => p.full_name));
    }

    if (plan.switch && !(plan.switch in by_name)) {
        errors.push(new PlanError({
            code: ErrorCode.VLAN_SWITCH_NOT_FOUND,
            device: plan.switch,
            message: `Switch '${plan.switch}' does not exist in the active topology.`,
            suggestion: "Call pt_query_topology to see the real names.",
        }));
    }
    if (plan.router && !(plan.router in by_name)) {
        errors.push(new PlanError({
            code: ErrorCode.VLAN_ROUTER_NOT_FOUND,
            device: plan.router,
            message: `Router '${plan.router}' does not exist in the active topology.`,
            suggestion: "Call pt_query_topology to see the real names.",
        }));
    }

    // Validate trunk/access ports against the model (if the switch exists)
    if (plan.switch in by_name) {
        const valid = _ports_of(plan.switch);
        if (valid.size) {
            for (const ap of plan.access_ports) {
                if (!valid.has(ap.port)) {
                    const sorted_valid = [...valid].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
                    errors.push(new PlanError({
                        code: ErrorCode.VLAN_INTERFACE_NOT_FOUND,
                        device: plan.switch,
                        message: `Access port '${ap.port}' does not exist on ${by_name[plan.switch]["model"]}.`,
                        suggestion: `Valid ports: ${sorted_valid.join(", ")}`,
                    }));
                }
            }
            for (const t of plan.trunks) {
                if (!valid.has(t.port)) {
                    const sorted_valid = [...valid].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
                    errors.push(new PlanError({
                        code: ErrorCode.VLAN_TRUNK_PORT_INVALID,
                        device: plan.switch,
                        message: `Trunk port '${t.port}' does not exist on ${by_name[plan.switch]["model"]}.`,
                        suggestion: `Valid ports: ${sorted_valid.join(", ")}`,
                    }));
                }
            }
        }
    }

    // Subinterfaces: the parent port must exist on the router
    if (plan.router in by_name) {
        const valid_r = _ports_of(plan.router);
        if (valid_r.size) {
            for (const s of plan.subinterfaces) {
                if (!valid_r.has(s.parent_port)) {
                    const sorted_valid = [...valid_r].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
                    errors.push(new PlanError({
                        code: ErrorCode.VLAN_INTERFACE_NOT_FOUND,
                        device: plan.router,
                        message: `Parent port '${s.parent_port}' does not exist on ${by_name[plan.router]["model"]}.`,
                        suggestion: `Valid ports: ${sorted_valid.join(", ")}`,
                    }));
                }
            }
        }
    }

    return new ValidationResult({ errors: errors, warnings: warnings });
}
