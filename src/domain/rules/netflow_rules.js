// NetFlow exporter validation.

import { IPv4Address } from "../../shared/ipnet.js";
import { ErrorCode, PlanError, ValidationResult } from "../models/errors.js";
import { has_control_chars } from "./text_rules.js";

// PT implements v5 (fixed format) and v9 (template-based). Any other
// number is accepted by the setter but does not produce a working exporter.
export const VALID_VERSIONS = [5, 9];

function _is_ipv4(value) {
    try {
        new IPv4Address(value);
        return true;
    } catch {
        return false;
    }
}

export function validate_netflow(cfg) {
    const errors = [];
    const warnings = [];

    if (!cfg.name.trim()) {
        errors.push(new PlanError({
            code: ErrorCode.NETFLOW_INVALID_NAME, device: cfg.device,
            message: "The exporter needs a name.",
            suggestion: "Pass a short name, for example 'COLLECTOR-1'.",
        }));
    } else if (has_control_chars(cfg.name)) {
        errors.push(new PlanError({
            code: ErrorCode.NETFLOW_INVALID_NAME, device: cfg.device,
            message: "The exporter name contains line breaks.",
            suggestion: "Use a single-line name.",
        }));
    }

    if (cfg.destination_ip && !_is_ipv4(cfg.destination_ip)) {
        errors.push(new PlanError({
            code: ErrorCode.NETFLOW_INVALID_DESTINATION, device: cfg.device,
            message: `'${cfg.destination_ip}' is not a valid IPv4 address.`,
            suggestion: "Give the collector's IP, for example 192.168.0.50.",
        }));
    }

    if (!(1 <= cfg.udp_port && cfg.udp_port <= 65535)) {
        errors.push(new PlanError({
            code: ErrorCode.NETFLOW_INVALID_PORT, device: cfg.device,
            message: `UDP port ${cfg.udp_port} out of range (1-65535).`,
            suggestion: "The usual NetFlow collector port is 2055.",
        }));
    }

    if (!VALID_VERSIONS.includes(cfg.version)) {
        errors.push(new PlanError({
            code: ErrorCode.NETFLOW_INVALID_VERSION, device: cfg.device,
            message: `NetFlow version ${cfg.version} is not supported by PT.`,
            suggestion: "Use 9 (templates, recommended) or 5 (fixed format).",
        }));
    }

    if (has_control_chars(cfg.source_port)) {
        errors.push(new PlanError({
            code: ErrorCode.NETFLOW_INVALID_NAME, device: cfg.device,
            message: "The source interface contains line breaks.",
            suggestion: "Use the exact port name, for example GigabitEthernet0/0.",
        }));
    }

    for (const monitor of cfg.monitors) {
        if (has_control_chars(monitor) || !monitor.trim()) {
            errors.push(new PlanError({
                code: ErrorCode.NETFLOW_INVALID_NAME, device: cfg.device,
                message: `Invalid monitor name: '${monitor}'.`,
                suggestion: "Each monitor is a single-line, non-empty name.",
            }));
        }
    }

    // Without a destination the exporter is created but inert: PT reports it as not
    // fully configured. It is valid (it can be completed later), but a warning is advisable.
    if (!cfg.destination_ip) {
        warnings.push(new PlanError({
            code: ErrorCode.NETFLOW_INCOMPLETE, device: cfg.device,
            message: "Without a destination IP the exporter sends no flows.",
            suggestion: "Add destination_ip pointing to the collector.",
        }));
    }

    return new ValidationResult({ errors: errors, warnings: warnings });
}

export function validate_netflow_against_topology(cfg, devices_in_pt) {
    const errors = [];

    const match = devices_in_pt.find((d) => d["name"] === cfg.device) ?? null;
    if (match === null) {
        errors.push(new PlanError({
            code: ErrorCode.NETFLOW_DEVICE_NOT_FOUND, device: cfg.device,
            message: `Device '${cfg.device}' does not exist in the active topology.`,
            suggestion: "Call pt_query_topology to see the real names.",
        }));
        return new ValidationResult({ errors: errors });
    }

    if (cfg.source_port) {
        const ports = new Set((match["ports"] ?? []).map((p) => p["name"]));
        // If we could not read the ports we do not block: failing open is better
        // than rejecting a correct config because of an incomplete read.
        if (ports.size && !ports.has(cfg.source_port)) {
            errors.push(new PlanError({
                code: ErrorCode.NETFLOW_PORT_NOT_FOUND, device: cfg.device,
                message: `'${cfg.device}' has no port '${cfg.source_port}'.`,
                suggestion: "Use pt_inspect_ports to see the exact names.",
            }));
        }
    }

    return new ValidationResult({ errors: errors });
}
