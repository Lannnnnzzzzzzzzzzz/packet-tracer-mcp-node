// Validation rules for NAT/PAT.
//
// Static validations do not query PT. The dynamic check (router and interfaces
// exist in the active topology) is done from the use case, same as for ACLs.

import { IPv4Address } from "../../shared/ipnet.js";
import { PlanError, ErrorCode, ValidationResult } from "../models/errors.js";
import { resolve_model } from "../../infrastructure/catalog/devices.js";
import { has_control_chars } from "./text_rules.js";

function _is_ipv4(value) {
    try { new IPv4Address(value); return true; } catch { return false; }
}

export function validate_nat_config(config) {
    /** Statically validates a NATConfig. */
    const errors = [];
    const warnings = [];

    _validate_interfaces(config, errors);
    _validate_text_fields(config, errors);

    if (config.mode === "static") {
        _validate_static(config, errors);
    } else if (config.mode === "dynamic") {
        _validate_dynamic(config, errors);
    } else if (config.mode === "pat") {
        _validate_pat(config, errors);
    }

    return new ValidationResult({ errors: errors, warnings: warnings });
}

export function validate_nat_against_topology(config, devices_in_pt) {
    /** Validates that the router and its interfaces exist in the active PT topology. */
    const errors = [];
    const warnings = [];

    const device = devices_in_pt.find((d) => d["name"] === config.router) ?? null;
    if (device === null) {
        errors.push(new PlanError({
            code: ErrorCode.NAT_ROUTER_NOT_FOUND,
            device: config.router,
            message: `Router '${config.router}' does not exist in PT's active topology.`,
            suggestion: "Call pt_query_topology to see the available devices.",
        }));
        return new ValidationResult({ errors: errors, warnings: warnings });
    }

    const model = resolve_model(device["model"] ?? "");
    if (model !== null && model !== undefined) {
        const valid_ports = new Set(model.ports.map((p) => p.full_name));
        // Accepts sub-interfaces (e.g. "GigabitEthernet0/0/1.20") by validating that the
        // base port exists — PT creates them dynamically when encapsulation dot1Q is set.
        for (const [iface_label, iface] of [
            ["inside_interface", config.inside_interface],
            ["outside_interface", config.outside_interface],
        ]) {
            // Python: iface.split(".", 1)[0] — everything before the first "."
            // (e.g. "GigabitEthernet0/0.20" -> "GigabitEthernet0/0").
            const base = _py_split_dot_first(iface);
            if (!valid_ports.has(iface) && !valid_ports.has(base)) {
                const sorted_ports = [...valid_ports].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
                errors.push(new PlanError({
                    code: ErrorCode.NAT_INTERFACE_NOT_FOUND,
                    device: config.router,
                    message: `${iface_label} '${iface}' does not exist on ${device["model"]}.`,
                    suggestion: `Available ports: ${sorted_ports.join(", ")} (.N subinterfaces are valid if the base port exists)`,
                }));
            }
        }
    }

    return new ValidationResult({ errors: errors, warnings: warnings });
}

function _py_split_dot_first(s) {
    // Python "a.b.c".split(".", 1)[0] == "a"; for "GigabitEthernet0/0.20" that is
    // "GigabitEthernet0/0" only because there is a single dot — the first dot.
    const idx = s.indexOf(".");
    return idx === -1 ? s : s.slice(0, idx);
}

// ----------------------------------------------------------------------
// Private helpers
// ----------------------------------------------------------------------

function _validate_interfaces(config, errors) {
    if (config.inside_interface === config.outside_interface) {
        errors.push(new PlanError({
            code: ErrorCode.NAT_SAME_INTERFACE,
            device: config.router,
            message: "inside_interface and outside_interface cannot be the same interface.",
            suggestion: "The 'inside' interface connects to the LAN and the 'outside' one to the WAN/Internet.",
        }));
    }
}

function _validate_text_fields(config, errors) {
    /** acl_number, the pool and the interfaces are interpolated raw into the CLI
     * (`ip nat pool {name}`, `ip nat inside source list {acl} ...`). */
    const fields = [
        ["acl_number", config.acl_number],
        ["inside_interface", config.inside_interface],
        ["outside_interface", config.outside_interface],
    ];
    if (config.pool !== null && config.pool !== undefined) {
        fields.push(["pool_name", config.pool.name]);
    }
    for (const [label, value] of fields) {
        if (has_control_chars(value)) {
            errors.push(new PlanError({
                code: ErrorCode.NAT_INVALID_NAME,
                device: config.router,
                message: `${label} contains a line break.`,
                suggestion: `Use a single-line value in ${label}.`,
            }));
        }
    }
}

function _validate_static(config, errors) {
    if (!config.static_mappings.length) {
        errors.push(new PlanError({
            code: ErrorCode.NAT_MISSING_STATIC_MAPPINGS,
            device: config.router,
            message: "Static NAT requires at least one static mapping (inside_local ↔ inside_global).",
            suggestion: "Add a dict {'inside_local': 'private_IP', 'inside_global': 'public_IP'}.",
        }));
        return;
    }

    config.static_mappings.forEach((m, i) => {
        const label = `static_mappings[${i}]`;
        _require_ipv4(m.inside_local, `${label}.inside_local`, config.router, errors);
        _require_ipv4(m.inside_global, `${label}.inside_global`, config.router, errors);
    });
}

function _validate_dynamic(config, errors) {
    if (!config.inside_networks.length) {
        errors.push(new PlanError({
            code: ErrorCode.NAT_MISSING_INSIDE_NETWORKS,
            device: config.router,
            message: "Dynamic NAT requires inside_networks to build the access-list.",
            suggestion: "E.g. ['192.168.1.0 0.0.0.255']. Or set acl_number to an existing ACL.",
        }));
    } else {
        _validate_inside_networks(config, errors);
    }

    if (config.pool === null || config.pool === undefined) {
        errors.push(new PlanError({
            code: ErrorCode.NAT_MISSING_POOL,
            device: config.router,
            message: "Dynamic NAT requires a pool of public IPs.",
            suggestion: "Set pool_name, pool_start, pool_end and pool_netmask.",
        }));
    } else {
        _validate_pool(config.pool, config.router, errors);
    }
}

function _validate_pat(config, errors) {
    if (!config.inside_networks.length) {
        errors.push(new PlanError({
            code: ErrorCode.NAT_MISSING_INSIDE_NETWORKS,
            device: config.router,
            message: "PAT requires inside_networks to identify the hosts to translate.",
            suggestion: "E.g. ['192.168.1.0 0.0.0.255']. Include every internal subnet.",
        }));
    } else {
        _validate_inside_networks(config, errors);
    }

    if (!config.use_interface_overload && (config.pool === null || config.pool === undefined)) {
        errors.push(new PlanError({
            code: ErrorCode.NAT_MISSING_POOL,
            device: config.router,
            message: "PAT with use_interface_overload=False requires a pool.",
            suggestion: "Set pool_name/start/end/netmask, or use use_interface_overload=True " +
                       "if the public IP is directly on outside_interface.",
        }));
    } else if (!config.use_interface_overload && config.pool !== null && config.pool !== undefined) {
        _validate_pool(config.pool, config.router, errors);
    }
}

function _validate_inside_networks(config, errors) {
    config.inside_networks.forEach((net0, i) => {
        const label = `inside_networks[${i}]`;
        const net = net0.trim();
        if (net === "any") {
            return;
        }
        const parts = net.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 2 && parts[0] === "host") {
            _require_ipv4(parts[1], `${label} (host)`, config.router, errors);
            return;
        }
        if (parts.length === 2) {
            try {
                new IPv4Address(parts[0]);
                new IPv4Address(parts[1]);
            } catch {
                errors.push(new PlanError({
                    code: ErrorCode.NAT_INVALID_IP,
                    device: config.router,
                    message: `${label}: '${net}' is not a valid 'network wildcard' pair.`,
                    suggestion: "Format: 'A.B.C.D W.W.W.W' (e.g. '192.168.1.0 0.0.0.255').",
                }));
            }
            return;
        }
        errors.push(new PlanError({
            code: ErrorCode.NAT_INVALID_IP,
            device: config.router,
            message: `${label}: invalid format '${net}'.`,
            suggestion: "Use 'any', 'host A.B.C.D' or 'A.B.C.D wildcard'.",
        }));
    });
}

function _validate_pool(pool, router, errors) {
    _require_ipv4(pool.start_ip, "pool.start_ip", router, errors);
    _require_ipv4(pool.end_ip, "pool.end_ip", router, errors);
    try {
        new IPv4Address(pool.netmask);
        // Check that it is a valid mask (not a wildcard)
        const packed = new IPv4Address(pool.netmask)._int;
        // A valid network mask has all the 1s followed by all the 0s
        if (packed !== 0) {
            const inverted = (packed ^ 0xFFFFFFFF) >>> 0;
            if (((inverted & (inverted + 1)) >>> 0) !== 0) {
                errors.push(new PlanError({
                    code: ErrorCode.NAT_INVALID_NETMASK,
                    device: router,
                    message: `pool.netmask '${pool.netmask}' is not a valid subnet mask.`,
                    suggestion: "Use mask format (e.g. '255.255.255.0'), NOT wildcard.",
                }));
            }
        }
    } catch {
        errors.push(new PlanError({
            code: ErrorCode.NAT_INVALID_NETMASK,
            device: router,
            message: `pool.netmask '${pool.netmask}' is not a valid IPv4 address.`,
        }));
    }

    // Check that start <= end (only if both are valid IPv4)
    try {
        const start = new IPv4Address(pool.start_ip)._int;
        const end = new IPv4Address(pool.end_ip)._int;
        if (start > end) {
            errors.push(new PlanError({
                code: ErrorCode.NAT_POOL_RANGE_INVALID,
                device: router,
                message: `pool.start_ip '${pool.start_ip}' is greater than pool.end_ip '${pool.end_ip}'.`,
            }));
        }
    } catch {
        // already reported above
    }
}

function _require_ipv4(value, label, router, errors) {
    if (!_is_ipv4(value)) {
        errors.push(new PlanError({
            code: ErrorCode.NAT_INVALID_IP,
            device: router,
            message: `${label}: '${value}' is not a valid IPv4 address.`,
        }));
    }
}
