// STP and port-security validation.

import { PlanError, ErrorCode, ValidationResult } from "../models/errors.js";
import { resolve_model } from "../../infrastructure/catalog/devices.js";

function _switch_in_pt(name, devices_in_pt) {
    return devices_in_pt.find((d) => d["name"] === name) ?? null;
}

function _port_in_model(switch_, port) {
    const model = resolve_model(switch_["model"] ?? "");
    if (model === null || model === undefined) {
        return true; // cannot verify → do not block
    }
    return new Set(model.ports.map((p) => p.full_name)).has(port);
}

export function validate_stp(cfg) {
    const errors = [];
    for (const [vlan, prio] of Object.entries(cfg.priority)) {
        if (!(0 <= prio && prio <= 61440) || prio % 4096 !== 0) {
            errors.push(new PlanError({
                code: ErrorCode.STP_INVALID_PRIORITY,
                device: cfg.switch,
                message: `Invalid STP priority ${prio} (VLAN ${vlan}).`,
                suggestion: "It must be 0-61440 and a multiple of 4096 (e.g. 4096, 8192, 24576).",
            }));
        }
    }
    return new ValidationResult({ errors: errors });
}

export function validate_stp_against_topology(cfg, devices_in_pt) {
    const errors = [];
    const sw = _switch_in_pt(cfg.switch, devices_in_pt);
    if (sw === null) {
        errors.push(new PlanError({
            code: ErrorCode.STP_SWITCH_NOT_FOUND,
            device: cfg.switch,
            message: `Switch '${cfg.switch}' does not exist in the active topology.`,
            suggestion: "Call pt_query_topology to see the real names.",
        }));
    }
    return new ValidationResult({ errors: errors });
}

export function validate_port_security(cfg) {
    const errors = [];
    if (cfg.max_mac < 1 || cfg.max_mac > 8192) {
        errors.push(new PlanError({
            code: ErrorCode.PORTSEC_INVALID_MAX,
            device: cfg.switch,
            message: `max_mac ${cfg.max_mac} out of range (1-8192).`,
            suggestion: "Use a maximum MAC address count between 1 and 8192.",
        }));
    }
    for (const mac of cfg.static_macs) {
        const cleaned = mac.replaceAll(".", "").replaceAll(":", "").replaceAll("-", "");
        if (cleaned.length !== 12) {
            errors.push(new PlanError({
                code: ErrorCode.PORTSEC_INVALID_MAC,
                device: cfg.switch,
                message: `Invalid MAC '${mac}'.`,
                suggestion: "Use the IOS format aaaa.bbbb.cccc.",
            }));
        }
    }
    return new ValidationResult({ errors: errors });
}

export function validate_port_security_against_topology(cfg, devices_in_pt) {
    const errors = [];
    const sw = _switch_in_pt(cfg.switch, devices_in_pt);
    if (sw === null) {
        errors.push(new PlanError({
            code: ErrorCode.PORTSEC_SWITCH_NOT_FOUND,
            device: cfg.switch,
            message: `Switch '${cfg.switch}' does not exist in the active topology.`,
            suggestion: "Call pt_query_topology to see the real names.",
        }));
    } else if (!_port_in_model(sw, cfg.port)) {
        errors.push(new PlanError({
            code: ErrorCode.PORTSEC_SWITCH_NOT_FOUND,
            device: cfg.switch,
            message: `Port '${cfg.port}' does not exist on ${sw["model"]}.`,
            suggestion: "Check the ports with pt_get_device_details.",
        }));
    }
    return new ValidationResult({ errors: errors });
}
