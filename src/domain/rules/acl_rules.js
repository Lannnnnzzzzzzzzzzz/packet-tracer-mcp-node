// Validation rules for ACLs.
//
// The validations here are static (they do not query PT). To verify that the
// router/interface exist in the active topology, the bridge is queried from the
// corresponding use case.

import { IPv4Address } from "../../shared/ipnet.js";
import { pyTruthy } from "../../shared/pycompat.js";
import { PlanError, ErrorCode, ValidationResult } from "../models/errors.js";
import { has_control_chars } from "./text_rules.js";

// IOS numeric ranges:
//  1-99       Standard IP ACL
//  100-199    Extended IP ACL
//  1300-1999  Standard IP ACL (expanded)
//  2000-2699  Extended IP ACL (expanded)
const _STANDARD_RANGES = [[1, 99], [1300, 1999]];
const _EXTENDED_RANGES = [[100, 199], [2000, 2699]];

const _PROTOCOLS_WITH_PORTS = new Set(["tcp", "udp"]);
const _PROTOCOLS_WITH_ICMP_TYPE = new Set(["icmp"]);

export function validate_acl_plan(plan) {
    /** Statically validates an ACLPlan. */
    const errors = [];
    const warnings = [];

    if (!pyTruthy(plan.entries)) {
        errors.push(new PlanError({
            code: ErrorCode.ACL_EMPTY,
            device: plan.router,
            message: `ACL '${plan.name_or_number}' has no rules. An empty ACL denies everything (implicit deny any).`,
            suggestion: "Add at least one 'permit' rule at the end, or don't apply the ACL.",
        }));
    }

    _validate_number_or_name(plan, errors);
    _validate_entries(plan, errors, warnings);
    _detect_unreachable_rules(plan, warnings);

    return new ValidationResult({ errors: errors, warnings: warnings });
}

export function validate_acl_binding(binding, plan) {
    /** Validates consistency between a binding and its ACLPlan. */
    const errors = [];
    if (binding.router !== plan.router) {
        errors.push(new PlanError({
            code: ErrorCode.ACL_ROUTER_NOT_FOUND,
            device: binding.router,
            message: `Binding points to '${binding.router}' but the ACL was planned for '${plan.router}'.`,
        }));
    }
    if (binding.acl_id !== plan.name_or_number) {
        errors.push(new PlanError({
            code: ErrorCode.VALIDATION_ERROR,
            device: binding.router,
            message: `Binding references ACL '${binding.acl_id}' but the plan is for '${plan.name_or_number}'.`,
        }));
    }
    return new ValidationResult({ errors: errors });
}

// ----------------------------------------------------------------------
// Private helpers
// ----------------------------------------------------------------------

function _validate_number_or_name(plan, errors) {
    /** If name_or_number is numeric, it must be in a range consistent with acl_type. */
    if (has_control_chars(plan.name_or_number)) {
        errors.push(new PlanError({
            code: ErrorCode.ACL_INVALID_NAME,
            device: plan.router,
            message: "The ACL name contains a line break.",
            suggestion: "Use a single-line ACL name.",
        }));
        return;
    }

    const nn = plan.name_or_number.trim();
    if (!/^\d+$/.test(nn)) {
        // Alphanumeric name — IOS accepts it for named ACLs
        return;
    }

    const n = parseInt(nn, 10);
    const in_standard = _STANDARD_RANGES.some(([lo, hi]) => lo <= n && n <= hi);
    const in_extended = _EXTENDED_RANGES.some(([lo, hi]) => lo <= n && n <= hi);

    if (!in_standard && !in_extended) {
        errors.push(new PlanError({
            code: ErrorCode.ACL_INVALID_NUMBER,
            device: plan.router,
            message: `ACL number ${n} is outside the valid ranges.`,
            suggestion: "Use 1-99 (standard), 100-199 (extended), 1300-1999, or 2000-2699.",
        }));
        return;
    }

    if (plan.acl_type === "standard" && !in_standard) {
        errors.push(new PlanError({
            code: ErrorCode.ACL_TYPE_MISMATCH,
            device: plan.router,
            message: `ACL ${n} declared as 'standard' but the number is in the extended range.`,
        }));
    }
    if (plan.acl_type === "extended" && !in_extended) {
        errors.push(new PlanError({
            code: ErrorCode.ACL_TYPE_MISMATCH,
            device: plan.router,
            message: `ACL ${n} declared as 'extended' but the number is in the standard range.`,
        }));
    }
}

function _validate_entries(plan, errors, warnings) {
    const seen_sequences = new Set();

    plan.entries.forEach((entry, idx) => {
        const label = `ACL '${plan.name_or_number}' regla #${idx + 1}`;

        if (entry.remark && has_control_chars(entry.remark)) {
            errors.push(new PlanError({
                code: ErrorCode.ACL_INVALID_REMARK,
                device: plan.router,
                message: `${label}: the remark contains a line break.`,
                suggestion: "Use a single-line remark.",
            }));
        }

        // Duplicate sequence
        if (entry.sequence !== null && entry.sequence !== undefined) {
            if (seen_sequences.has(entry.sequence)) {
                errors.push(new PlanError({
                    code: ErrorCode.ACL_DUPLICATE_SEQUENCE,
                    device: plan.router,
                    message: `${label}: secuencia ${entry.sequence} duplicada.`,
                }));
            }
            seen_sequences.add(entry.sequence);
        }

        // Standard does not accept destination or ports
        if (plan.acl_type === "standard") {
            if (entry.destination) {
                errors.push(new PlanError({
                    code: ErrorCode.ACL_TYPE_MISMATCH,
                    device: plan.router,
                    message: `${label}: a standard ACL does not support 'destination'. Use acl_type='extended' or remove the destination.`,
                }));
            }
            if (entry.source_port_op || entry.dest_port_op || pyTruthy(entry.tcp_flags) || entry.icmp_type) {
                errors.push(new PlanError({
                    code: ErrorCode.ACL_TYPE_MISMATCH,
                    device: plan.router,
                    message: `${label}: a standard ACL does not support ports/flags/icmp-type.`,
                }));
            }
            if (entry.protocol !== "ip") {
                errors.push(new PlanError({
                    code: ErrorCode.ACL_TYPE_MISMATCH,
                    device: plan.router,
                    message: `${label}: a standard ACL only supports protocol='ip'.`,
                }));
            }
        }

        // Ports are only valid for TCP/UDP
        const has_ports = entry.source_port_op || entry.dest_port_op;
        if (has_ports && !_PROTOCOLS_WITH_PORTS.has(entry.protocol)) {
            errors.push(new PlanError({
                code: ErrorCode.ACL_INVALID_PROTOCOL_FOR_PORTS,
                device: plan.router,
                message: `${label}: protocol='${entry.protocol}' does not support ports. Only TCP/UDP do.`,
            }));
        }

        // ICMP type only for ICMP
        if (entry.icmp_type && entry.protocol !== "icmp") {
            errors.push(new PlanError({
                code: ErrorCode.ACL_INVALID_PROTOCOL_FOR_PORTS,
                device: plan.router,
                message: `${label}: icmp_type only applies with protocol='icmp'.`,
            }));
        }

        // Validate IPs / wildcards
        _validate_address(entry.source, label + " source", plan.router, errors);
        if (entry.destination) {
            _validate_address(entry.destination, label + " destination", plan.router, errors);
        }
    });
}

function _validate_address(addr, label, device, errors) {
    /** Validates 'any', 'host X.X.X.X', or 'X.X.X.X Y.Y.Y.Y' (network + wildcard). */
    addr = addr.trim();
    if (addr === "any") {
        return;
    }
    const parts = addr.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 2 && parts[0] === "host") {
        try {
            new IPv4Address(parts[1]);
            return;
        } catch {
            errors.push(new PlanError({
                code: ErrorCode.INVALID_IP_ADDRESS,
                device: device,
                message: `${label}: '${parts[1]}' is not a valid IPv4 address.`,
            }));
            return;
        }
    }
    if (parts.length === 2) {
        try {
            new IPv4Address(parts[0]);
            new IPv4Address(parts[1]);
            return;
        } catch {
            errors.push(new PlanError({
                code: ErrorCode.ACL_INVALID_WILDCARD,
                device: device,
                message: `${label}: '${addr}' is not a valid 'network wildcard'.`,
                suggestion: "Format: 'A.B.C.D 0.0.0.W' (e.g. '192.168.1.0 0.0.0.255').",
            }));
            return;
        }
    }
    errors.push(new PlanError({
        code: ErrorCode.INVALID_IP_ADDRESS,
        device: device,
        message: `${label}: invalid format '${addr}'.`,
        suggestion: "Use 'any', 'host A.B.C.D' or 'A.B.C.D wildcard'.",
    }));
}

function _detect_unreachable_rules(plan, warnings) {
    /** Warns if there are rules after a permit/deny catch-all. */
    let catch_all_at = null;
    plan.entries.forEach((entry, idx) => {
        const is_catch_all = (
            entry.source === "any"
            && (entry.destination === "any" || plan.acl_type === "standard")
            && entry.protocol === "ip"
            && (entry.source_port_op === null || entry.source_port_op === undefined)
            && (entry.dest_port_op === null || entry.dest_port_op === undefined)
            && !pyTruthy(entry.tcp_flags)
            && !entry.icmp_type
        );
        if (catch_all_at !== null) {
            warnings.push(new PlanError({
                code: ErrorCode.ACL_UNREACHABLE_RULE,
                device: plan.router,
                message: `Rule #${idx + 1} is unreachable: there is a catch-all at rule #${catch_all_at + 1}.`,
                suggestion: "Reorder the rules so the specific ones come before the catch-all.",
            }));
        }
        if (is_catch_all && catch_all_at === null) {
            catch_all_at = idx;
        }
    });
}
