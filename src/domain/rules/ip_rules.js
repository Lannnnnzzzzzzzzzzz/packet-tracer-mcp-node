// IP validation rules.

import { ip_interface, IPv4Address } from "../../shared/ipnet.js";
import { PlanError, ErrorCode } from "../models/errors.js";
import { has_control_chars } from "./text_rules.js";

function _ipv4_interface(v) {
    // Python ipaddress.IPv4Interface: validates the address and the prefix/mask.
    const s = String(v);
    const parts = s.split("/");
    if (parts.length > 2) throw new Error(`'${s}' does not appear to be an IPv4 address`);
    new IPv4Address(parts[0]);
    if (parts.length === 2) {
        const p = parts[1];
        if (p.includes(".")) {
            new IPv4Address(p);
        } else if (!/^\d+$/.test(p) || parseInt(p, 10) > 32) {
            throw new Error(`'${p}' is not a valid netmask`);
        }
    }
    return ip_interface(s);
}

export function validate_ips(plan) {
    /** Checks that there are no IP conflicts. */
    const errors = [];
    const all_ips = {};

    for (const dev of plan.devices) {
        for (const [iface, ip_cidr] of Object.entries(dev.interfaces)) {
            let ip_str;
            try {
                const ip_obj = _ipv4_interface(ip_cidr);
                ip_str = String(ip_obj.ip);
            } catch {
                errors.push(new PlanError({
                    code: ErrorCode.INVALID_IP_ADDRESS,
                    device: dev.name,
                    message: `Invalid IP '${ip_cidr}' on interface ${iface}.`,
                    suggestion: "Verificar formato IP. Ejemplo: 192.168.1.1/24",
                }));
                continue;
            }

            const key = `${dev.name}:${iface}`;
            if (ip_str in all_ips) {
                errors.push(new PlanError({
                    code: ErrorCode.IP_CONFLICT,
                    device: dev.name,
                    message: `IP ${ip_str} duplicada entre ${all_ips[ip_str]} y ${key}.`,
                    suggestion: "Reassign one of the conflicting IPs.",
                }));
            } else {
                all_ips[ip_str] = key;
            }
        }
    }

    return errors;
}

export function validate_dhcp(plan) {
    /** Checks DHCP pools. */
    const errors = [];

    for (const pool of plan.dhcp_pools) {
        if (has_control_chars(pool.pool_name)) {
            errors.push(new PlanError({
                code: ErrorCode.DHCP_INVALID_POOL_NAME,
                device: pool.router,
                message: `The DHCP pool name '${pool.pool_name}' contains a line break.`,
                suggestion: "Use a single-line pool name.",
            }));
        }

        const router = plan.device_by_name(pool.router);
        if (router === null) {
            errors.push(new PlanError({
                code: ErrorCode.DHCP_ROUTER_NOT_FOUND,
                device: pool.router,
                message: `DHCP pool '${pool.pool_name}' referencia router inexistente.`,
                suggestion: "Check the router name.",
            }));
            continue;
        }

        const gw_found = Object.values(router.interfaces).some(
            (ip) => _is_valid_ip(ip) && String(_ipv4_interface(ip).ip) === pool.gateway
        );
        if (!gw_found) {
            errors.push(new PlanError({
                code: ErrorCode.DHCP_GATEWAY_MISMATCH,
                device: pool.router,
                message: `Gateway ${pool.gateway} of pool '${pool.pool_name}' is not assigned to an interface of ${pool.router}.`,
                suggestion: "Assign the gateway to a router interface.",
            }));
        }
    }

    return errors;
}

function _is_valid_ip(ip_cidr) {
    try {
        _ipv4_interface(ip_cidr);
        return true;
    } catch {
        return false;
    }
}
