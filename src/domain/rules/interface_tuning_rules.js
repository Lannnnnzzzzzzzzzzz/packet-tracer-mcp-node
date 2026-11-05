// Per-interface fine-tuning validation.

import { PlanError, ErrorCode, ValidationResult } from "../models/errors.js";
import { has_control_chars } from "./text_rules.js";

// Valid clock rates (bps) accepted by IOS on serial interfaces.
const _VALID_CLOCK_RATES = new Set([
    1200, 2400, 4800, 9600, 19200, 38400, 56000, 64000, 72000, 125000,
    148000, 250000, 500000, 800000, 1000000, 1300000, 2000000, 4000000,
]);

// PT 9.0.1 answers `ip ospf network broadcast` with % Invalid input.
export const OSPF_NETWORK_TYPES = new Set(["point-to-point"]);

export function validate_interface_tuning(cfg) {
    const errors = [];
    const warnings = [];

    if (has_control_chars(cfg.router) || has_control_chars(cfg.interface)) {
        // Both are interpolated into the single-string IOS payload.
        errors.push(new PlanError({
            code: ErrorCode.VALIDATION_ERROR, device: cfg.router,
            message: "The router or interface name contains a line break.",
            suggestion: "Use the exact names from pt_query_topology.",
        }));
    }

    if (cfg.clock_rate !== null && cfg.clock_rate !== undefined) {
        if (!cfg.is_serial()) {
            errors.push(new PlanError({
                code: ErrorCode.IFTUNE_CLOCKRATE_NOT_SERIAL,
                device: cfg.router,
                message: `clock_rate only applies to Serial interfaces, not to '${cfg.interface}'.`,
                suggestion: "Remove clock_rate or use a Serial interface (DCE end).",
            }));
        } else if (!_VALID_CLOCK_RATES.has(cfg.clock_rate)) {
            warnings.push(new PlanError({
                code: ErrorCode.IFTUNE_CLOCKRATE_NOT_SERIAL,
                device: cfg.router,
                message: `clock_rate ${cfg.clock_rate} is not a standard IOS value.`,
                suggestion: "Valores comunes: 64000, 128000, 1000000, 2000000.",
            }));
        }
    }

    if (cfg.ospf_network !== null && cfg.ospf_network !== undefined && !OSPF_NETWORK_TYPES.has(cfg.ospf_network)) {
        errors.push(new PlanError({
            code: ErrorCode.VALIDATION_ERROR, device: cfg.router,
            message: `ospf_network '${cfg.ospf_network}' is not supported.`,
            suggestion: "PT accepts only 'point-to-point' (use it on /30 links between routers).",
        }));
    }

    // --- OSPF authentication ---
    for (const [label, value] of [["ospf_auth_key", cfg.ospf_auth_key],
                                  ["ospf_md5_key", cfg.ospf_md5_key]]) {
        if (value === null || value === undefined) {
            continue;
        }
        if (!value.trim()) {
            errors.push(new PlanError({
                code: ErrorCode.IFTUNE_INVALID_OSPF_AUTH, device: cfg.router,
                message: `${label} is empty.`,
                suggestion: "Pass a key or remove the parameter.",
            }));
        } else if (value.includes(" ") || has_control_chars(value)) {
            // The key ends up inside a single-line IOS payload; a line break would
            // turn into an unrequested command.
            errors.push(new PlanError({
                code: ErrorCode.IFTUNE_INVALID_OSPF_AUTH, device: cfg.router,
                message: `${label} contains spaces or line breaks.`,
                suggestion: "IOS does not accept spaces in the key: use a single word.",
            }));
        }
    }

    if (cfg.ospf_md5_key !== null && cfg.ospf_md5_key !== undefined) {
        if (cfg.ospf_md5_key_id === null || cfg.ospf_md5_key_id === undefined) {
            errors.push(new PlanError({
                code: ErrorCode.IFTUNE_INVALID_OSPF_AUTH, device: cfg.router,
                message: "ospf_md5_key needs an ospf_md5_key_id.",
                suggestion: "Use an id between 1 and 255; it must match the neighbor's.",
            }));
        } else if (!(1 <= cfg.ospf_md5_key_id && cfg.ospf_md5_key_id <= 255)) {
            errors.push(new PlanError({
                code: ErrorCode.IFTUNE_INVALID_OSPF_AUTH, device: cfg.router,
                message: `ospf_md5_key_id ${cfg.ospf_md5_key_id} out of range (1-255).`,
                suggestion: "Use an id between 1 and 255.",
            }));
        }
        if (cfg.ospf_auth_key !== null && cfg.ospf_auth_key !== undefined) {
            warnings.push(new PlanError({
                code: ErrorCode.IFTUNE_INVALID_OSPF_AUTH, device: cfg.router,
                message: "Both auth_key and md5_key were passed; only MD5 is applied.",
                suggestion: "Remove ospf_auth_key: message-digest is the recommended mode.",
            }));
        }
    } else if (cfg.ospf_auth_key !== null && cfg.ospf_auth_key !== undefined) {
        warnings.push(new PlanError({
            code: ErrorCode.IFTUNE_INVALID_OSPF_AUTH, device: cfg.router,
            message: "Plain-text OSPF authentication travels readable across the network.",
            suggestion: "Prefer ospf_md5_key + ospf_md5_key_id (message-digest).",
        }));
    }

    // The timers must match the neighbor's or the adjacency does not form.
    // The IOS default is dead = 4 x hello.
    if (cfg.ospf_dead_interval !== null && cfg.ospf_dead_interval !== undefined
        && cfg.ospf_hello_interval !== null && cfg.ospf_hello_interval !== undefined) {
        if (cfg.ospf_dead_interval <= cfg.ospf_hello_interval) {
            errors.push(new PlanError({
                code: ErrorCode.IFTUNE_INVALID_OSPF_TIMERS, device: cfg.router,
                message: (
                    `dead-interval (${cfg.ospf_dead_interval}s) must be greater ` +
                    `than hello-interval (${cfg.ospf_hello_interval}s).`
                ),
                suggestion: "The IOS convention is dead = 4 x hello.",
            }));
        }
    }

    return new ValidationResult({ errors: errors, warnings: warnings });
}

export function validate_interface_tuning_against_topology(cfg, devices_in_pt) {
    const errors = [];
    const dev = devices_in_pt.find((d) => d["name"] === cfg.router) ?? null;
    if (dev === null) {
        errors.push(new PlanError({
            code: ErrorCode.IFTUNE_DEVICE_NOT_FOUND,
            device: cfg.router,
            message: `Router '${cfg.router}' does not exist in the active topology.`,
            suggestion: "Call pt_query_topology to see the real names.",
        }));
        return new ValidationResult({ errors: errors });
    }

    // Validate that the interface exists (it may be a subinterface "Gig0/0.10")
    const ports = new Set((dev["ports"] ?? []).map((p) => p["name"]));
    const base = cfg.interface.split(".", 1)[0];
    if (ports.size && !ports.has(cfg.interface) && !ports.has(base)) {
        const available = [...ports].filter((p) => p).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        errors.push(new PlanError({
            code: ErrorCode.IFTUNE_INTERFACE_NOT_FOUND,
            device: cfg.router,
            message: `Interface '${cfg.interface}' does not exist on ${dev["model"]}.`,
            suggestion: `Available ports: ${available.join(", ")}`,
        }));
    }
    return new ValidationResult({ errors: errors });
}
