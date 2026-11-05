// Cisco CME voice validation.
//
// Measured in PT 9: a 2811 accepts `telephony-service` and its sub-commands (status 0);
// a 2911 answers status 2 (invalid input) even after `license boot module c2900
// technology-package uck9` + write + reload (the uc package stays "disable"). Every other
// router model is unmeasured, so only the 2811 is allowed.

import { IPv4Address, IPv4Network, ip_interface } from "../../shared/ipnet.js";
import { normalize_mac } from "../models/voice.js";
import { PlanError, ErrorCode, ValidationResult } from "../models/errors.js";
import { resolve_model, category_of_model, get_valid_ports } from "../../infrastructure/catalog/devices.js";
import { has_control_chars } from "./text_rules.js";

// The only router whose CME commands were measured as accepted.
export const CME_ROUTER = "2811";
// Why the others are refused (measured, or simply not measured).
export const CME_REFUSED_REASON = {
    "2911": "PT's 2911 rejects `telephony-service` (status 2, invalid input), even after " +
            "`license boot module c2900 technology-package uck9` + write + reload.",
};
// IOS limits on a 2811; only 5/5 were measured.
export const MAX_EPHONES_RANGE = [1, 36];
export const MAX_DN_RANGE = [1, 144];
export const EXTENSION_RE = /^\d{1,16}$/;
export const POOL_NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
export const PORT_RE = /^(FastEthernet|GigabitEthernet)(\d+\/)*\d+$/;
export const RESERVED_VLANS = Array.from({ length: 1006 - 1002 }, (_, i) => 1002 + i);

function _err(code, device, message, suggestion) {
    return new PlanError({ code: code, device: device, message: message, suggestion: suggestion });
}

function _source_ip(cfg) {
    let ip;
    try {
        ip = new IPv4Address(cfg.source_ip.trim());
    } catch {
        return null;
    }
    if (ip.is_multicast || ip.is_loopback || ip._int === 0 || ip.is_reserved) {
        return null;
    }
    return ip;
}

export function validate_voice(cfg) {
    const errors = [];
    const warnings = [];
    const r = cfg.router;
    const src = _source_ip(cfg);
    if (src === null) {
        errors.push(_err(ErrorCode.VOICE_INVALID_SOURCE_IP, r,
                           `source_ip '${cfg.source_ip}' is not a usable unicast IPv4 address.`,
                           "Use the IP of the router interface facing the phones."));
    }
    if (cfg.source_port !== 2000) {
        warnings.push(_err(ErrorCode.VOICE_INVALID_RANGE, r,
                             `SCCP port ${cfg.source_port} was not measured; only 2000 was.`,
                             "Keep the default port 2000 unless you know why."));
    }
    if (!(1 <= cfg.source_port && cfg.source_port <= 65535)) {
        errors.push(_err(ErrorCode.VOICE_INVALID_RANGE, r,
                           `Port ${cfg.source_port} out of range (1-65535).`, "Use 2000."));
    }
    for (const [label, value, [lo, hi]] of [["max_ephones", cfg.max_ephones, MAX_EPHONES_RANGE],
                                   ["max_dn", cfg.max_dn, MAX_DN_RANGE]]) {
        if (!(lo <= value && value <= hi)) {
            errors.push(_err(ErrorCode.VOICE_INVALID_RANGE, r,
                               `${label} ${value} out of range (${lo}-${hi} on a 2811).`,
                               `Use a value between ${lo} and ${hi} (5 was measured).`));
        }
    }

    if (!cfg.extensions.length) {
        errors.push(_err(ErrorCode.VOICE_INVALID_EXTENSION, r,
                           "No extensions: CME needs at least one ephone-dn.",
                           'Pass extensions=[{"number": "1001"}, {"number": "1002"}].'));
    }
    const numbers = new Set();
    const macs = new Set();
    for (const ext of cfg.extensions) {
        const number = ext.number.trim();
        if (!EXTENSION_RE.test(number)) {
            errors.push(_err(ErrorCode.VOICE_INVALID_EXTENSION, r,
                               `Extension '${ext.number}' is not 1-16 digits.`,
                               "Use digits only, e.g. '1001'."));
        } else if (numbers.has(number)) {
            errors.push(_err(ErrorCode.VOICE_INVALID_EXTENSION, r,
                               `Extension ${number} is repeated.`,
                               "Every extension number must be unique."));
        }
        numbers.add(number);
        if (ext.mac !== null && ext.mac !== undefined) {
            const mac = normalize_mac(ext.mac);
            if (mac === null) {
                errors.push(_err(ErrorCode.VOICE_INVALID_EXTENSION, r,
                                   `MAC '${ext.mac}' of extension ${number} is not a MAC address.`,
                                   "Use the phone's MAC, e.g. '0001.4321.ABCD' " +
                                   "(pt_get_device_details / pt_inspect_ports)."));
            } else if (macs.has(mac)) {
                errors.push(_err(ErrorCode.VOICE_INVALID_EXTENSION, r,
                                   `MAC ${mac} is given to more than one extension.`,
                                   "One phone per MAC; omit mac to let auto assign do it."));
            } else {
                macs.add(mac);
            }
        }
    }
    if (cfg.extensions.length > cfg.max_dn) {
        errors.push(_err(ErrorCode.VOICE_INVALID_RANGE, r,
                           `${cfg.extensions.length} extensions but max_dn is ${cfg.max_dn}.`,
                           `Raise max_dn to at least ${cfg.extensions.length}.`));
    }
    if (macs.size > cfg.max_ephones) {
        errors.push(_err(ErrorCode.VOICE_INVALID_RANGE, r,
                           `${macs.size} phones with a MAC but max_ephones is ${cfg.max_ephones}.`,
                           `Raise max_ephones to at least ${macs.size}.`));
    }
    if (macs.size) {
        warnings.push(_err(ErrorCode.VOICE_INVALID_EXTENSION, r,
                             "`ephone` / `mac-address` / `button` were NOT measured in PT yet.",
                             "Check rejected_lines and `show running-config`; or omit mac " +
                             "and rely on auto assign."));
    }
    if (!cfg.auto_assign && !macs.size) {
        warnings.push(_err(ErrorCode.VOICE_INVALID_EXTENSION, r,
                             "auto_assign is off and no extension has a MAC: no phone will " +
                             "get a number.",
                             "Set auto_assign=True or give each extension the phone's MAC."));
    }

    _validate_switch_part(cfg, errors, warnings);
    _validate_dhcp_part(cfg, src, errors, warnings);
    return new ValidationResult({ errors: errors, warnings: warnings });
}

function _validate_switch_part(cfg, errors, warnings) {
    const sw = cfg.switch || "";
    if (cfg.voice_vlan === null || cfg.voice_vlan === undefined) {
        if (cfg.switch || cfg.access_ports.length) {
            errors.push(_err(ErrorCode.VOICE_INVALID_VLAN, sw,
                               "switch/access_ports given without voice_vlan.",
                               "Pass voice_vlan (e.g. 1 or 150), or drop switch/access_ports."));
        }
        return;
    }
    if (!(1 <= cfg.voice_vlan && cfg.voice_vlan <= 4094) || RESERVED_VLANS.includes(cfg.voice_vlan)) {
        errors.push(_err(ErrorCode.VOICE_INVALID_VLAN, sw,
                           `voice_vlan ${cfg.voice_vlan} is not usable (1-4094, not 1002-1005).`,
                           "Use e.g. 150, or 1 for a flat lab."));
    }
    if (!sw.trim() || has_control_chars(sw)) {
        errors.push(_err(ErrorCode.VOICE_DEVICE_NOT_FOUND, sw,
                           "voice_vlan needs the access switch name.", 'Pass switch="SW1".'));
    }
    if (!cfg.access_ports.length) {
        errors.push(_err(ErrorCode.VOICE_INVALID_PORT, sw,
                           "voice_vlan needs the access ports where the phones plug in.",
                           'Pass access_ports=["FastEthernet0/2", "FastEthernet0/3"].'));
    }
    const seen = new Set();
    for (const port of cfg.access_ports) {
        const p = port.trim();
        if (has_control_chars(port) || !PORT_RE.test(p)) {
            errors.push(_err(ErrorCode.VOICE_INVALID_PORT, sw,
                               `'${port}' is not a full switch port name.`,
                               "Use e.g. 'FastEthernet0/2'."));
        } else if (seen.has(p)) {
            errors.push(_err(ErrorCode.VOICE_INVALID_PORT, sw,
                               `Port ${p} is listed twice.`, "List each port once."));
        }
        seen.add(p);
    }
    warnings.push(_err(ErrorCode.VOICE_INVALID_VLAN, sw,
                         "`switchport voice vlan` was NOT measured in PT yet.",
                         "Check rejected_lines and `show running-config` on the switch."));
    if (cfg.voice_vlan !== 1) {
        warnings.push(_err(ErrorCode.VOICE_INVALID_VLAN, sw,
                             `VLAN ${cfg.voice_vlan} needs a router subinterface (or SVI) ` +
                             "and its own DHCP pool for the phones to get an address.",
                             "For a flat lab use voice_vlan=1 and one DHCP pool."));
    }
}

function _validate_dhcp_part(cfg, src, errors, warnings) {
    const r = cfg.router;
    if (cfg.dhcp_pool === null || cfg.dhcp_pool === undefined) {
        if (cfg.dhcp_network) {
            errors.push(_err(ErrorCode.VOICE_INVALID_DHCP, r,
                               "dhcp_network given without dhcp_pool.",
                               'Pass dhcp_pool="VOICE" too.'));
        }
        return;
    }
    if (has_control_chars(cfg.dhcp_pool) || !POOL_NAME_RE.test(cfg.dhcp_pool.trim())) {
        errors.push(_err(ErrorCode.VOICE_INVALID_DHCP, r,
                           `DHCP pool name '${cfg.dhcp_pool}' is not one IOS word.`,
                           "Use letters, digits, '_', '-' or '.', e.g. 'VOICE'."));
    }
    // `option 150 ip` was measured end to end on PT 9.0.1: the 7960s got it and registered.
    if (!cfg.dhcp_network) {
        warnings.push(_err(ErrorCode.VOICE_INVALID_DHCP, r,
                             `Only \`option 150\` is added to pool '${cfg.dhcp_pool}': the pool ` +
                             "must already have its network and default-router.",
                             "Pass dhcp_network (e.g. '10.10.10.0/24') to create them too."));
        return;
    }
    let net;
    try {
        const s = cfg.dhcp_network.trim();
        const parts = s.split("/");
        if (parts.length === 2 && parts[1].includes(".")) {
            net = new IPv4Network(s);
        } else if (parts.length === 2 && (!/^\d+$/.test(parts[1]) || parseInt(parts[1], 10) > 32)) {
            throw new Error("bad prefix");
        } else if (parts.length > 2) {
            throw new Error("bad network");
        } else {
            net = new IPv4Network(s); // strict=False in Python: host bits masked
        }
        new IPv4Address(parts[0]);
    } catch {
        errors.push(_err(ErrorCode.VOICE_INVALID_DHCP, r,
                           `dhcp_network '${cfg.dhcp_network}' is not an IPv4 network.`,
                           "Use CIDR, e.g. '10.10.10.0/24'."));
        return;
    }
    if (net.prefixlen > 30) {
        errors.push(_err(ErrorCode.VOICE_INVALID_DHCP, r,
                           `dhcp_network ${net} has no room for phones.`,
                           "Use a /24 or similar."));
    }
    if (src !== null && (!net.contains(src) || src.eq(net.network_address)
                                                       || src.eq(net.broadcast_address))) {
        errors.push(_err(ErrorCode.VOICE_INVALID_DHCP, r,
                           `source_ip ${src} is not a host of dhcp_network ${net}.`,
                           "The pool must be the phones' subnet, where source_ip is the " +
                           "router's interface (and their gateway)."));
    }
}

function _device(name, devices_in_pt) {
    return devices_in_pt.find((d) => d["name"] === name) ?? null;
}

function _interface_ips(dev) {
    const out = [];
    for (const p of dev["ports"] || []) {
        if (!p["ip"] || !p["mask"]) {
            continue;
        }
        let iface;
        try {
            iface = ip_interface(`${p["ip"]}/${p["mask"]}`);
        } catch {
            continue;
        }
        if (iface.ip._int) {
            out.push(iface);
        }
    }
    return out;
}

export function check_cme_router(dev, errors) {
    /** Error unless the router is a 2811, the only model measured to accept CME. */
    const name = dev["name"] ?? "";
    const model_name = dev["model"] ?? "";
    const model = resolve_model(model_name);
    const pt_type = model ? model.pt_type : model_name;
    if (pt_type === CME_ROUTER) {
        return;
    }
    let message;
    if (model !== null && model !== undefined && model.category !== "router") {
        message = `CME needs a router; '${name}' is a ${model_name}.`;
    } else {
        const reason = (pt_type in CME_REFUSED_REASON)
            ? CME_REFUSED_REASON[pt_type]
            : `CME was not measured on a ${model_name || "router of unknown model"} ` +
                     "in PT; only the 2811 accepts `telephony-service`.";
        message = `'${name}' (${model_name}) cannot run CME voice: ${reason}`;
    }
    errors.push(_err(ErrorCode.VOICE_UNSUPPORTED_ROUTER, name, message,
                       "Use a 2811 as the call manager (pt_add_device model '2811', or " +
                       "pt_full_build(router_model='2811'))."));
}

export function validate_voice_against_topology(cfg, devices_in_pt) {
    const errors = [];
    const warnings = [];
    const dev = _device(cfg.router, devices_in_pt);
    if (dev === null) {
        errors.push(_err(ErrorCode.VOICE_DEVICE_NOT_FOUND, cfg.router,
                           `Router '${cfg.router}' does not exist in the active topology.`,
                           "Call pt_query_topology to see the real names."));
    } else {
        check_cme_router(dev, errors);
        const src = _source_ip(cfg);
        const ifaces = _interface_ips(dev);
        if (src !== null && !ifaces.length) {
            warnings.push(_err(ErrorCode.VOICE_INVALID_SOURCE_IP, cfg.router,
                                 `${cfg.router} has no interface IPv4 in PT (or it could not ` +
                                 "be read): source_ip was not checked.",
                                 "Give the LAN interface its IP first (phones register to it)."));
        } else if (src !== null && ifaces.every((i) => !i.ip.eq(src))) {
            const own = ifaces.map((i) => String(i)).join(", ");
            errors.push(_err(ErrorCode.VOICE_INVALID_SOURCE_IP, cfg.router,
                               `source_ip ${src} is not an IP of ${cfg.router} (${own}).`,
                               "Use the IP of the interface facing the phones."));
        }
    }
    if (cfg.voice_vlan !== null && cfg.voice_vlan !== undefined && cfg.switch) {
        const sw = _device(cfg.switch, devices_in_pt);
        if (sw === null) {
            errors.push(_err(ErrorCode.VOICE_DEVICE_NOT_FOUND, cfg.switch,
                               `Switch '${cfg.switch}' does not exist in the active topology.`,
                               "Call pt_query_topology to see the real names."));
        } else {
            const category = category_of_model(sw["model"] ?? "");
            if (category && !["switch", "multilayer_switch"].includes(category)) {
                errors.push(_err(ErrorCode.VOICE_DEVICE_NOT_FOUND, cfg.switch,
                                   `'${cfg.switch}' is a ${sw["model"]}, not a switch.`,
                                   "Pass the access switch the phones plug into."));
            }
            let names = new Set((sw["ports"] || []).map((p) => p["name"]).filter((n) => n));
            names = names.size ? names : get_valid_ports(sw["model"] ?? "");
            for (const port of cfg.access_ports) {
                if (names.size && !names.has(port.trim())) {
                    errors.push(_err(ErrorCode.VOICE_INVALID_PORT, cfg.switch,
                                       `Port '${port}' does not exist on ${sw["model"]}.`,
                                       "Check the ports with pt_inspect_ports."));
                }
            }
        }
    }
    return new ValidationResult({ errors: errors, warnings: warnings });
}
