// HSRP, BGP and QoS validation.
//
// Ranges and keywords are limited to what was measured on a 2911 in PT 9 (every
// generated line answered status 0 and showed up in `show running-config`). Anything
// IOS takes but was not measured is a warning, not an error.

import { IPv4Address, IPv4Network, ip_interface } from "../../shared/ipnet.js";
import { pyTruthy } from "../../shared/pycompat.js";
import { PlanError, ErrorCode, ValidationResult } from "../models/errors.js";
import { resolve_model, category_of_model, get_valid_ports } from "../../infrastructure/catalog/devices.js";
import { has_control_chars } from "./text_rules.js";

// The model every command here was measured on.
export const MEASURED_ROUTER = "2911";
// L3 switches that run these features in IOS, but were not measured in PT.
export const MULTILAYER_SWITCHES = new Set(["3560-24PS", "3650-24PS"]);

export const HSRP_GROUP_MAX = { 1: 255, 2: 4095 };
export const BGP_ASN_RANGE = [1, 65535]; // 2-byte ASN; asplain 4-byte ASNs were not measured
export const QOS_KBPS_RANGE = [8, 2000000];

// class-map / policy-map names: one IOS word.
export const QOS_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
export const DSCP_KEYWORDS = new Set([
    "default", "ef",
    ...Array.from({ length: 4 }, (_, i) => i + 1).flatMap((c) =>
        Array.from({ length: 3 }, (_, j) => j + 1).map((d) => `af${c}${d}`)),
    ...Array.from({ length: 8 }, (_, i) => `cs${i}`),
]);
// Measured: `match protocol rtp` and `match ip dscp ef`.
export const MEASURED_PROTOCOLS = new Set(["rtp"]);
export const MEASURED_DSCP = new Set(["ef"]);
export const PROTOCOL_RE = /^[a-z][a-z0-9-]{0,31}$/;
// Nominal interface speed (kbps) by name prefix, to sanity-check reservations.
export const NOMINAL_KBPS = { "gigabitethernet": 1000000, "fastethernet": 100000, "ethernet": 10000,
                "serial": 1544 };
// IOS reserves at most 75% of the interface for priority + bandwidth by default.
export const MAX_RESERVABLE = 0.75;

function _py_first_dot(s) {
    const idx = s.indexOf(".");
    return idx === -1 ? s : s.slice(0, idx);
}

function _device(name, devices_in_pt) {
    return devices_in_pt.find((d) => d["name"] === name) ?? null;
}

function _live_port(dev, interface_) {
    /** The live port record for `interface` (a subinterface maps to its parent). */
    const ports = dev["ports"] || [];
    const base = _py_first_dot(interface_);
    return (ports.find((p) => p["name"] === interface_) ?? null)
            || (ports.find((p) => p["name"] === base) ?? null);
}

function _interface_exists(dev, interface_) {
    /** Checked against the live ports, else the catalog; unknown model → True. */
    const base = _py_first_dot(interface_);
    let names = new Set((dev["ports"] || []).map((p) => p["name"]).filter((n) => n));
    if (!names.size) {
        names = get_valid_ports(dev["model"] ?? "");
    }
    return !names.size || names.has(interface_) || names.has(base);
}

function _port_network(port) {
    /** (interface IP, its subnet) from a live port, or None when it has no IPv4. */
    if (!port || !port["ip"] || !port["mask"]) {
        return null;
    }
    let iface;
    try {
        iface = ip_interface(`${port["ip"]}/${port["mask"]}`);
    } catch {
        return null;
    }
    if (iface.ip._int === 0) {
        return null;
    }
    return [iface.ip, iface.network];
}

export function check_router_model(dev, feature, code, errors, warnings) {
    /** Error on a device that cannot run `feature`; warning on an unmeasured model. */
    const model_name = dev["model"] ?? "";
    const model = resolve_model(model_name);
    if (model === null || model === undefined) {
        return;
    }
    const name = dev["name"] ?? "";
    if (model.category !== "router" && !MULTILAYER_SWITCHES.has(model.pt_type)) {
        errors.push(new PlanError({
            code: code, device: name,
            message: `${feature} needs a router; '${name}' is a ${model_name} ` +
                    `(${category_of_model(model_name) || "unknown"}).`,
            suggestion: "Apply it to a router (measured on a 2911).",
        }));
    } else if (model.pt_type !== MEASURED_ROUTER) {
        warnings.push(new PlanError({
            code: ErrorCode.FEATURE_UNSUPPORTED_DEVICE, device: name,
            message: `${feature} was measured on a 2911 only; ${model_name} is NOT verified.`,
            suggestion: "Check the reply's rejected_lines and `show running-config`.",
        }));
    }
}

function _router_and_interface(router, interface_, devices_in_pt, feature,
                          not_found, iface_not_found, errors, warnings) {
    const dev = _device(router, devices_in_pt);
    if (dev === null) {
        errors.push(new PlanError({
            code: not_found, device: router,
            message: `Router '${router}' does not exist in the active topology.`,
            suggestion: "Call pt_query_topology to see the real names.",
        }));
        return null;
    }
    check_router_model(dev, feature, ErrorCode.FEATURE_UNSUPPORTED_DEVICE, errors, warnings);
    if (interface_ && !_interface_exists(dev, interface_)) {
        errors.push(new PlanError({
            code: iface_not_found, device: router,
            message: `Interface '${interface_}' does not exist on ${dev["model"]}.`,
            suggestion: "Check the ports with pt_get_device_details or pt_inspect_ports.",
        }));
        return null;
    }
    return dev;
}

// ---------------------------------------------------------------------------
// HSRP
// ---------------------------------------------------------------------------

export function validate_hsrp(cfg) {
    const errors = [];
    const warnings = [];
    if (has_control_chars(cfg.interface) || !cfg.interface.trim()) {
        errors.push(new PlanError({
            code: ErrorCode.HSRP_INTERFACE_NOT_FOUND, device: cfg.router,
            message: "The interface name is empty or contains a line break.",
            suggestion: "Pass the exact port name, e.g. 'GigabitEthernet0/0'.",
        }));
    }
    if (!(cfg.version in HSRP_GROUP_MAX)) {
        errors.push(new PlanError({
            code: ErrorCode.HSRP_INVALID_VERSION, device: cfg.router,
            message: `HSRP version ${cfg.version} does not exist.`,
            suggestion: "Use version 2 (measured in PT) or 1.",
        }));
    } else {
        if (cfg.version === 1) {
            warnings.push(new PlanError({
                code: ErrorCode.HSRP_INVALID_VERSION, device: cfg.router,
                message: "HSRP version 1 was not measured in PT; only version 2 was.",
                suggestion: "Prefer version=2 unless the peer router runs version 1.",
            }));
        }
        const top = HSRP_GROUP_MAX[cfg.version];
        if (!(0 <= cfg.group && cfg.group <= top)) {
            errors.push(new PlanError({
                code: ErrorCode.HSRP_INVALID_GROUP, device: cfg.router,
                message: `HSRP group ${cfg.group} out of range for version ${cfg.version} (0-${top}).`,
                suggestion: `Use a group between 0 and ${top}; both routers must use the same one.`,
            }));
        }
    }
    if (!(0 <= cfg.priority && cfg.priority <= 255)) {
        errors.push(new PlanError({
            code: ErrorCode.HSRP_INVALID_PRIORITY, device: cfg.router,
            message: `HSRP priority ${cfg.priority} out of range (0-255).`,
            suggestion: "Default is 100; give the active router a higher one (e.g. 110).",
        }));
    }
    let vip_ok = false;
    try {
        const vip = new IPv4Address(cfg.virtual_ip.trim());
        if (!(vip.is_multicast || vip.is_loopback || vip._int === 0 || vip.is_reserved)) {
            vip_ok = true;
        }
    } catch { /* fall through */ }
    if (!vip_ok) {
        errors.push(new PlanError({
            code: ErrorCode.HSRP_INVALID_VIRTUAL_IP, device: cfg.router,
            message: `virtual_ip '${cfg.virtual_ip}' is not a usable unicast IPv4 address.`,
            suggestion: "Use a free address in the interface's subnet (the hosts' gateway).",
        }));
    }
    return new ValidationResult({ errors: errors, warnings: warnings });
}

export function validate_hsrp_against_topology(cfg, devices_in_pt) {
    const errors = [];
    const warnings = [];
    const dev = _router_and_interface(cfg.router, cfg.interface, devices_in_pt, "HSRP",
                                ErrorCode.HSRP_DEVICE_NOT_FOUND,
                                ErrorCode.HSRP_INTERFACE_NOT_FOUND, errors, warnings);
    if (dev === null || (pyTruthy(dev["ports"]) && cfg.interface.includes("."))) {
        // A subinterface's own IP is not in the live port list: nothing more to check.
        return new ValidationResult({ errors: errors, warnings: warnings });
    }
    const net = _port_network(_live_port(dev, cfg.interface));
    if (net === null) {
        warnings.push(new PlanError({
            code: ErrorCode.HSRP_INVALID_VIRTUAL_IP, device: cfg.router,
            message: `${cfg.interface} has no IPv4 address in PT (or it could not be read).`,
            suggestion: "HSRP needs an interface IP in the virtual IP's subnet: set it first.",
        }));
        return new ValidationResult({ errors: errors, warnings: warnings });
    }
    const [ip, network] = net;
    let vip;
    try {
        vip = new IPv4Address(cfg.virtual_ip.trim());
    } catch {
        return new ValidationResult({ errors: errors, warnings: warnings });
    }
    if (!network.contains(vip) || vip.eq(network.network_address) || vip.eq(network.broadcast_address)) {
        errors.push(new PlanError({
            code: ErrorCode.HSRP_INVALID_VIRTUAL_IP, device: cfg.router,
            message: `virtual_ip ${vip} is not a host address of ${cfg.interface}'s subnet ${network}.`,
            suggestion: `Pick a free host address inside ${network}.`,
        }));
    } else if (vip.eq(ip)) {
        errors.push(new PlanError({
            code: ErrorCode.HSRP_INVALID_VIRTUAL_IP, device: cfg.router,
            message: `virtual_ip ${vip} is the interface's own address.`,
            suggestion: "The virtual IP must be a third address, shared by both routers.",
        }));
    }
    return new ValidationResult({ errors: errors, warnings: warnings });
}

// ---------------------------------------------------------------------------
// BGP
// ---------------------------------------------------------------------------

function _asn_ok(asn) {
    return BGP_ASN_RANGE[0] <= asn && asn <= BGP_ASN_RANGE[1];
}

function _parse_network(text) {
    try {
        const s = text.trim();
        const parts = s.split("/");
        if (parts.length !== 2) return null;
        const addr = new IPv4Address(parts[0]);
        const p = parts[1];
        let net;
        if (p.includes(".")) {
            net = new IPv4Network(s);
        } else {
            if (!/^\d+$/.test(p) || parseInt(p, 10) > 32) return null;
            net = new IPv4Network(s);
        }
        if (net.network_address._int !== addr._int) return null; // strict=True: host bits
        return net;
    } catch {
        return null;
    }
}

export function validate_bgp(cfg) {
    const errors = [];
    const warnings = [];
    if (!_asn_ok(cfg.asn)) {
        errors.push(new PlanError({
            code: ErrorCode.BGP_INVALID_ASN, device: cfg.router,
            message: `ASN ${cfg.asn} out of range (${BGP_ASN_RANGE[0]}-${BGP_ASN_RANGE[1]}).`,
            suggestion: "Use a 2-byte ASN; 64512-65534 are the private ones.",
        }));
    }
    if (!cfg.neighbors.length && !cfg.networks.length) {
        errors.push(new PlanError({
            code: ErrorCode.BGP_EMPTY, device: cfg.router,
            message: "Neither neighbors nor networks were given.",
            suggestion: "Pass at least one neighbor {ip, remote_as}.",
        }));
    } else if (!cfg.neighbors.length) {
        warnings.push(new PlanError({
            code: ErrorCode.BGP_EMPTY, device: cfg.router,
            message: "No neighbors: the networks are not advertised to anyone.",
            suggestion: "Add a neighbor {ip, remote_as}.",
        }));
    }
    const seen = new Set();
    for (const n of cfg.neighbors) {
        let addr;
        try {
            addr = new IPv4Address(n.ip.trim());
            if (addr.is_multicast || addr.is_loopback || addr._int === 0) {
                throw new Error("unusable");
            }
        } catch {
            errors.push(new PlanError({
                code: ErrorCode.BGP_INVALID_NEIGHBOR, device: cfg.router,
                message: `Neighbor IP '${n.ip}' is not a usable unicast IPv4 address.`,
                suggestion: "Use the peer's interface address on the shared link.",
            }));
            continue;
        }
        if (seen.has(String(addr))) {
            errors.push(new PlanError({
                code: ErrorCode.BGP_INVALID_NEIGHBOR, device: cfg.router,
                message: `Neighbor ${addr} is listed twice.`,
                suggestion: "Give each neighbor once.",
            }));
        }
        seen.add(String(addr));
        if (!_asn_ok(n.remote_as)) {
            errors.push(new PlanError({
                code: ErrorCode.BGP_INVALID_ASN, device: cfg.router,
                message: `remote_as ${n.remote_as} of ${addr} out of range ` +
                        `(${BGP_ASN_RANGE[0]}-${BGP_ASN_RANGE[1]}).`,
                suggestion: "Use the peer's 2-byte ASN.",
            }));
        }
    }
    const nets = new Set();
    for (const text of cfg.networks) {
        const net = _parse_network(text);
        if (net === null || !text.includes("/")) {
            errors.push(new PlanError({
                code: ErrorCode.BGP_INVALID_NETWORK, device: cfg.router,
                message: `Network '${text}' is not a valid IPv4 network in CIDR form.`,
                suggestion: "Use 'network/prefix' with the host bits at zero, e.g. '192.168.1.0/24'.",
            }));
        } else if (nets.has(String(net))) {
            errors.push(new PlanError({
                code: ErrorCode.BGP_INVALID_NETWORK, device: cfg.router,
                message: `Network ${net} is listed twice.`, suggestion: "Give each network once.",
            }));
        } else {
            nets.add(String(net));
        }
    }
    return new ValidationResult({ errors: errors, warnings: warnings });
}

export function validate_bgp_against_topology(cfg, devices_in_pt) {
    const errors = [];
    const warnings = [];
    const dev = _router_and_interface(cfg.router, "", devices_in_pt, "BGP",
                                ErrorCode.BGP_DEVICE_NOT_FOUND, ErrorCode.BGP_DEVICE_NOT_FOUND,
                                errors, warnings);
    if (dev === null) {
        return new ValidationResult({ errors: errors, warnings: warnings });
    }
    const connected = (dev["ports"] || []).map((p) => _port_network(p)).filter((n) => n);
    if (!connected.length) {
        return new ValidationResult({ errors: errors, warnings: warnings });
    }
    const own_ips = new Set(connected.map(([ip]) => String(ip)));
    for (const n of cfg.neighbors) {
        let addr;
        try {
            addr = new IPv4Address(n.ip.trim());
        } catch {
            continue;
        }
        if (own_ips.has(String(addr))) {
            errors.push(new PlanError({
                code: ErrorCode.BGP_INVALID_NEIGHBOR, device: cfg.router,
                message: `Neighbor ${addr} is one of ${cfg.router}'s own addresses.`,
                suggestion: "Use the PEER's address on the shared link.",
            }));
        } else if (!connected.some(([, net]) => net.contains(addr))) {
            warnings.push(new PlanError({
                code: ErrorCode.BGP_INVALID_NEIGHBOR, device: cfg.router,
                message: `Neighbor ${addr} is not on any of ${cfg.router}'s connected subnets.`,
                suggestion: "Without a route to it (or ebgp-multihop) the session never comes up.",
            }));
        }
    }
    const connected_nets = new Set(connected.map(([, net]) => String(net)));
    for (const text of cfg.networks) {
        const net = _parse_network(text);
        if (net !== null && !connected_nets.has(String(net))) {
            warnings.push(new PlanError({
                code: ErrorCode.BGP_INVALID_NETWORK, device: cfg.router,
                message: `${net} is not a connected subnet of ${cfg.router}.`,
                suggestion: "BGP only advertises a network present in the routing table " +
                           "with that exact mask (e.g. via a static or IGP route).",
            }));
        }
    }
    return new ValidationResult({ errors: errors, warnings: warnings });
}

// ---------------------------------------------------------------------------
// QoS (MQC: class-map, policy-map, service-policy)
// ---------------------------------------------------------------------------

function _qos_name_error(label, value, router) {
    if (QOS_NAME_RE.test(value || "") && (value || "").toLowerCase() !== "class-default") {
        return null;
    }
    return new PlanError({
        code: ErrorCode.QOS_INVALID_NAME, device: router,
        message: `${label} '${value}' is not a valid name.`,
        suggestion: "One word starting with a letter: letters, digits, '_', '-', '.' " +
                   "(max 40); 'class-default' is reserved.",
    });
}

export function validate_qos(cfg) {
    const errors = [];
    const warnings = [];
    if (cfg.direction !== "output") {
        errors.push(new PlanError({
            code: ErrorCode.QOS_INVALID_DIRECTION, device: cfg.router,
            message: `direction '${cfg.direction}' is not supported.`,
            suggestion: "Use 'output': priority, bandwidth and fair-queue are queuing " +
                       "actions, which IOS only applies outbound.",
        }));
    }
    if (has_control_chars(cfg.interface) || !cfg.interface.trim()) {
        errors.push(new PlanError({
            code: ErrorCode.QOS_INTERFACE_NOT_FOUND, device: cfg.router,
            message: "The interface name is empty or contains a line break.",
            suggestion: "Pass the exact port name, e.g. 'GigabitEthernet0/1'.",
        }));
    }
    {
        const err = _qos_name_error("policy_name", cfg.policy_name, cfg.router);
        if (err) {
            errors.push(err);
        }
    }
    if (!cfg.classes.length) {
        errors.push(new PlanError({
            code: ErrorCode.QOS_EMPTY, device: cfg.router,
            message: "The policy has no classes.",
            suggestion: "Pass classes=[{name, match_dscp|match_protocol, priority_kbps|bandwidth_kbps}].",
        }));
    }
    const names = new Set();
    let reserved = 0;
    for (const c of cfg.classes) {
        const err = _qos_name_error("Class name", c.name, cfg.router);
        if (err) {
            errors.push(err);
        } else if (names.has(c.name.toLowerCase())) {
            errors.push(new PlanError({
                code: ErrorCode.QOS_INVALID_NAME, device: cfg.router,
                message: `Class '${c.name}' is listed twice.`, suggestion: "Give each class once.",
            }));
        } else if (c.name.toLowerCase() === cfg.policy_name.toLowerCase()) {
            warnings.push(new PlanError({
                code: ErrorCode.QOS_INVALID_NAME, device: cfg.router,
                message: `Class '${c.name}' has the policy's name.`,
                suggestion: "IOS allows it, but distinct names are easier to read.",
            }));
        }
        names.add(c.name.toLowerCase());

        if (c.match_dscp === null && c.match_protocol === null) {
            errors.push(new PlanError({
                code: ErrorCode.QOS_INVALID_MATCH, device: cfg.router,
                message: `Class '${c.name}' has no match.`,
                suggestion: "Give match_dscp (e.g. 'ef') and/or match_protocol (e.g. 'rtp').",
            }));
        }
        if (c.match_dscp !== null && c.match_dscp !== undefined) {
            const dscp = String(c.match_dscp).trim().toLowerCase();
            if (!DSCP_KEYWORDS.has(dscp) && !(/^\d+$/.test(dscp) && 0 <= parseInt(dscp, 10) && parseInt(dscp, 10) <= 63)) {
                errors.push(new PlanError({
                    code: ErrorCode.QOS_INVALID_MATCH, device: cfg.router,
                    message: `match_dscp '${c.match_dscp}' is not a DSCP value.`,
                    suggestion: "Use ef, af11-af43, cs0-cs7, default or 0-63.",
                }));
            } else if (!MEASURED_DSCP.has(dscp)) {
                warnings.push(new PlanError({
                    code: ErrorCode.QOS_INVALID_MATCH, device: cfg.router,
                    message: `\`match ip dscp ${dscp}\` was not measured in PT (only 'ef' was).`,
                    suggestion: "Check the reply's rejected_lines.",
                }));
            }
        }
        if (c.match_protocol !== null && c.match_protocol !== undefined) {
            const proto = String(c.match_protocol).trim().toLowerCase();
            if (!PROTOCOL_RE.test(proto)) {
                errors.push(new PlanError({
                    code: ErrorCode.QOS_INVALID_MATCH, device: cfg.router,
                    message: `match_protocol '${c.match_protocol}' is not a protocol keyword.`,
                    suggestion: "Use an NBAR keyword such as 'rtp'.",
                }));
            } else if (!MEASURED_PROTOCOLS.has(proto)) {
                warnings.push(new PlanError({
                    code: ErrorCode.QOS_INVALID_MATCH, device: cfg.router,
                    message: `\`match protocol ${proto}\` was not measured in PT (only 'rtp' was).`,
                    suggestion: "Check the reply's rejected_lines.",
                }));
            }
        }

        const actions = [c.priority_kbps, c.bandwidth_kbps].filter((v) => v !== null && v !== undefined);
        if (actions.length !== 1) {
            errors.push(new PlanError({
                code: ErrorCode.QOS_INVALID_ACTION, device: cfg.router,
                message: `Class '${c.name}' needs exactly one of priority_kbps / bandwidth_kbps.`,
                suggestion: "priority_kbps for voice (LLQ), bandwidth_kbps for a guarantee.",
            }));
            continue;
        }
        const kbps = actions[0];
        if (!(QOS_KBPS_RANGE[0] <= kbps && kbps <= QOS_KBPS_RANGE[1])) {
            errors.push(new PlanError({
                code: ErrorCode.QOS_INVALID_ACTION, device: cfg.router,
                message: `${kbps} kbps out of range for class '${c.name}' ` +
                        `(${QOS_KBPS_RANGE[0]}-${QOS_KBPS_RANGE[1]}).`,
                suggestion: "Give the rate in kbps, e.g. 512.",
            }));
            continue;
        }
        reserved += kbps;
        if (c.bandwidth_kbps !== null && c.bandwidth_kbps !== undefined) {
            warnings.push(new PlanError({
                code: ErrorCode.QOS_INVALID_ACTION, device: cfg.router,
                message: `\`bandwidth ${kbps}\` (class '${c.name}') was not measured in PT; ` +
                        "`priority` was.",
                suggestion: "Check the reply's rejected_lines.",
            }));
        }
    }

    let speed = null;
    for (const [k, v] of Object.entries(NOMINAL_KBPS)) {
        if (cfg.interface.toLowerCase().startsWith(k)) { speed = v; break; }
    }
    if (speed && reserved > speed * MAX_RESERVABLE) {
        warnings.push(new PlanError({
            code: ErrorCode.QOS_INVALID_ACTION, device: cfg.router,
            message: `The classes reserve ${reserved} kbps, over 75% of ${cfg.interface}'s ` +
                    `nominal ${speed} kbps.`,
            suggestion: "By default IOS reserves at most 75%: the service-policy may be refused.",
        }));
    }
    return new ValidationResult({ errors: errors, warnings: warnings });
}

export function validate_qos_against_topology(cfg, devices_in_pt) {
    const errors = [];
    const warnings = [];
    _router_and_interface(cfg.router, cfg.interface, devices_in_pt, "QoS",
                          ErrorCode.QOS_DEVICE_NOT_FOUND, ErrorCode.QOS_INTERFACE_NOT_FOUND,
                          errors, warnings);
    return new ValidationResult({ errors: errors, warnings: warnings });
}
