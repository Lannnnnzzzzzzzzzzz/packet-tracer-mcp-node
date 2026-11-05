// Validation of DHCP pools on a Server-PT (pt_configure_dhcp_server).

import { IPv4Address, IPv4Network } from "../../shared/ipnet.js";
import { ErrorCode, PlanError, ValidationResult } from "../models/errors.js";
import { has_control_chars } from "./text_rules.js";

function _ipv4(value) {
    try {
        return new IPv4Address(value);
    } catch {
        return null;
    }
}

function _subnet(cfg) {
    /** The pool's subnet, or None if network/mask don't form a valid subnet. */
    try {
        // Python: IPv4Network(f"{network}/{mask}", strict=True)
        const net = new IPv4Network(`${cfg.network}/${cfg.mask}`);
        const addr = new IPv4Address(cfg.network);
        if (net.network_address._int !== addr._int) return null; // host bits set (strict)
        // dotted mask must be contiguous
        if (cfg.mask.includes(".")) {
            const bits = (new IPv4Address(cfg.mask)._int >>> 0).toString(2).padStart(32, "0");
            if (!/^1*0*$/.test(bits)) return null;
        }
        return net;
    } catch {
        return null;
    }
}

export function resolve_range(cfg) {
    /** Start and number of users sent to PT.
     *
     * PT computes the end itself (start + max_users - 1), so this is enough.
     * Without start_ip, the range starts after the gateway if the gateway is the
     * first host (the .1 convention); otherwise at the first host. Without
     * max_users, it runs to the last host of the subnet. Assumes a validated config.
     */
    const net = _subnet(cfg);
    if (net === null) throw new Error("resolve_range needs a validated config");
    const first = net.network_address.add(1);
    const last = net.broadcast_address.add(-1);
    let start;
    if (cfg.start_ip) {
        start = new IPv4Address(cfg.start_ip);
    } else {
        const gateway = cfg.gateway ? _ipv4(cfg.gateway) : null;
        start = (gateway !== null && gateway.eq(first)) ? first.add(1) : first;
    }
    const max_users = cfg.max_users || (last._int - start._int + 1);
    return [String(start), max_users];
}

export function validate_dhcp_server(cfg) {
    const errors = [];
    const warnings = [];

    function err(code, message, suggestion) {
        errors.push(new PlanError({ code: code, device: cfg.device, message: message, suggestion: suggestion }));
    }

    if (!cfg.pool_name.trim()) {
        err(ErrorCode.DHCP_INVALID_POOL_NAME, "The pool needs a name.",
            "Keep the default 'serverPool' or pass a name such as 'LAN10'.");
    } else if (has_control_chars(cfg.pool_name)) {
        err(ErrorCode.DHCP_INVALID_POOL_NAME, "The pool name contains line breaks.",
            "Use a single-line name.");
    }

    if (!cfg.port.trim() || has_control_chars(cfg.port)) {
        err(ErrorCode.DHCP_SERVER_PORT_NOT_FOUND, `Invalid port: '${cfg.port}'.`,
            "On a Server-PT the port is FastEthernet0.");
    }

    for (const field of ["network", "mask", "gateway", "dns", "start_ip"]) {
        const value = cfg[field];
        if (value && _ipv4(value) === null) {
            err(ErrorCode.DHCP_SERVER_INVALID_ADDRESS,
                `${field}='${value}' is not a valid IPv4 address.`,
                "Use dotted notation, for example 192.168.10.0.");
        }
    }

    if (!cfg.network) {
        err(ErrorCode.DHCP_SERVER_INVALID_ADDRESS, "The pool's network is missing.",
            "Pass network and mask, for example 192.168.10.0 and 255.255.255.0.");
    }

    if (cfg.max_users < 0) {
        err(ErrorCode.DHCP_SERVER_INVALID_RANGE, "max_users cannot be negative.",
            "Use 0 to run to the end of the subnet.");
    }

    if (errors.length) {
        return new ValidationResult({ errors: errors, warnings: warnings });
    }

    const net = _subnet(cfg);
    if (net === null) {
        err(ErrorCode.DHCP_SERVER_INVALID_ADDRESS,
            `${cfg.network}/${cfg.mask} is not a subnet: the network has host bits set ` +
            "or the mask is not contiguous.",
            "The network is the address with the host bits at zero (192.168.10.0, not .5).");
        return new ValidationResult({ errors: errors, warnings: warnings });
    }
    if (net.num_addresses < 4) {
        err(ErrorCode.DHCP_SERVER_INVALID_RANGE,
            `/${net.prefixlen} leaves no hosts to hand out.`,
            "Use a /30 mask or larger.");
        return new ValidationResult({ errors: errors, warnings: warnings });
    }

    const first = net.network_address.add(1);
    const last = net.broadcast_address.add(-1);

    const gateway = cfg.gateway ? _ipv4(cfg.gateway) : null;
    if (gateway !== null && !(first._int <= gateway._int && gateway._int <= last._int)) {
        err(ErrorCode.DHCP_SERVER_OUT_OF_SUBNET,
            `The gateway ${gateway} is not a host of ${net}.`,
            "The gateway is the router's IP on that LAN, inside the subnet.");
    }

    const [start_s, max_users] = resolve_range(cfg);
    const start = new IPv4Address(start_s);
    if (!(first._int <= start._int && start._int <= last._int)) {
        err(ErrorCode.DHCP_SERVER_OUT_OF_SUBNET,
            `start_ip ${start} is not a host of ${net}.`,
            `The range must start between ${first} and ${last}.`);
    } else if (max_users < 1 || start._int + max_users - 1 > last._int) {
        err(ErrorCode.DHCP_SERVER_INVALID_RANGE,
            `${max_users} users from ${start} run past the last host (${last}).`,
            `From ${start} at most ${last._int - start._int + 1} fit.`);
    }

    if (errors.length) {
        return new ValidationResult({ errors: errors, warnings: warnings });
    }

    const end = new IPv4Address(start._int + max_users - 1);
    if (gateway === null) {
        warnings.push(new PlanError({
            code: ErrorCode.DHCP_SERVER_INCOMPLETE, device: cfg.device,
            message: "Without a gateway, the clients can't leave their LAN.",
            suggestion: "Pass gateway with the router's IP on that subnet.",
        }));
    } else if (start._int <= gateway._int && gateway._int <= end._int) {
        warnings.push(new PlanError({
            code: ErrorCode.DHCP_SERVER_RANGE_OVERLAP, device: cfg.device,
            message: `The gateway ${gateway} is inside the range ${start}-${end}: ` +
                    "a client may receive the router's IP.",
            suggestion: "Start the range after the gateway (start_ip).",
        }));
    }

    return new ValidationResult({ errors: errors, warnings: warnings });
}

export function validate_dhcp_server_against_topology(cfg, devices_in_pt) {
    const errors = [];
    const warnings = [];

    const match = devices_in_pt.find((d) => d["name"] === cfg.device) ?? null;
    if (match === null) {
        errors.push(new PlanError({
            code: ErrorCode.DHCP_SERVER_DEVICE_NOT_FOUND, device: cfg.device,
            message: `Device '${cfg.device}' does not exist in the active topology.`,
            suggestion: "Call pt_query_topology to see the real names.",
        }));
        return new ValidationResult({ errors: errors });
    }

    const ports = {};
    for (const p of match["ports"] ?? []) ports[p["name"]] = p;
    // If the ports couldn't be read we don't block: failing open is better
    // than rejecting a correct config because of an incomplete read.
    if (!Object.keys(ports).length) {
        return new ValidationResult({ errors: errors });
    }
    const port = ports[cfg.port] ?? null;
    if (port === null) {
        const sorted_ports = Object.keys(ports).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        errors.push(new PlanError({
            code: ErrorCode.DHCP_SERVER_PORT_NOT_FOUND, device: cfg.device,
            message: `'${cfg.device}' has no port '${cfg.port}'.`,
            suggestion: `Real ports: ${sorted_ports.join(", ")}. This tool is for ` +
                       "Server-PT; on a router DHCP goes through the CLI (`ip dhcp pool`).",
        }));
        return new ValidationResult({ errors: errors });
    }

    const net = _subnet(cfg);
    const server_ip = _ipv4(port["ip"] || "");
    if (net === null) {
        return new ValidationResult({ errors: errors, warnings: warnings });
    }
    if (server_ip === null || server_ip.eq(new IPv4Address("0.0.0.0"))) {
        warnings.push(new PlanError({
            code: ErrorCode.DHCP_SERVER_NO_IP, device: cfg.device,
            message: `${cfg.device}/${cfg.port} has no IP: the server cannot answer.`,
            suggestion: "Give it a static IP inside the pool's subnet " +
                       "(pt_host_ip_config).",
        }));
    } else if (!net.contains(server_ip)) {
        warnings.push(new PlanError({
            code: ErrorCode.DHCP_SERVER_NO_IP, device: cfg.device,
            message: `The server's IP (${server_ip}) is outside ${net}.`,
            suggestion: "Without a relay (ip helper-address) clients on another subnet " +
                       "can't reach the server.",
        }));
    }
    return new ValidationResult({ errors: errors, warnings: warnings });
}
