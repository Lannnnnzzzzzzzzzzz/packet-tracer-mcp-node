// Validation of what is written into a host's panel (IP Configuration).
//
// These values end up in Script Engine setters (`setIpSubnetMask`,
// `setDefaultGateway`...). PT does not validate: a non-contiguous mask or an IP
// with spaces is stored as is and the host just doesn't work, with no visible error.

import { IPv4Address, IPv4Network, IPv6Address } from "../../shared/ipnet.js";
import { pyRepr, pyFloatRepr } from "../../shared/pycompat.js";
import { ErrorCode, PlanError, ValidationResult } from "../models/errors.js";
import { has_control_chars } from "./text_rules.js";

export const IP_MODES = ["", "static", "dhcp"];
export const IPV6_MODES = ["", "auto", "off"];

// Upper bounds for the waits the panel tools accept from the model.
export const MAX_BROWSER_TIMEOUT_S = 120.0;
export const MAX_DHCP_WAIT_S = 120.0;

function _isascii(s) { return [...s].every((c) => c.codePointAt(0) < 128); }

export function validate_wait_seconds(device, name, value, maximum, { allow_zero = false } = {}) {
    /** A wait in seconds: finite, positive (or 0 if allowed) and at most `maximum`. */
    const lowest_ok = allow_zero ? (v) => v >= 0 : (v) => v > 0;
    const ok = (typeof value === "number" && Number.isFinite(value)
          && lowest_ok(value) && value <= maximum);
    const errors = ok ? [] : [new PlanError({
        code: ErrorCode.PANEL_INVALID_VALUE, device: device,
        message: `${name}=${typeof value === "number" ? pyFloatRepr(value) : pyRepr(value)} is out of range ` +
                `(${allow_zero ? "0" : "more than 0"} to ${maximum.toFixed(0)} seconds).`,
        suggestion: `Use a value up to ${maximum.toFixed(0)}.`,
    })];
    return new ValidationResult({ errors: errors });
}

export function normalize_mask(mask) {
    /** '255.255.255.0', '24' or '/24' → '255.255.255.0'. None if it is not a valid mask.
     *
     * Accepted: prefixes /1../32 and contiguous dotted netmasks. Rejected (None):
     * /0 and 0.0.0.0 (never a host or pool mask), wildcard masks such as
     * 0.0.0.255 (`IPv4Network` would silently read them as a hostmask), and
     * non-ASCII digits ('²' passes `str.isdigit()` but makes `int()` raise).
     */
    let raw = (mask || "").trim();
    if (raw.startsWith("/")) {
        raw = raw.slice(1);
    }
    if (!raw || !_isascii(raw)) {
        return null;
    }
    if (/^\d+$/.test(raw)) {
        const n = parseInt(raw, 10);
        if (!(1 <= n && n <= 32)) {
            return null;
        }
        return String(new IPv4Network(`0.0.0.0/${n}`).netmask);
    }
    let value;
    try {
        value = new IPv4Address(raw)._int;
    } catch {
        return null;
    }
    // A netmask is a run of 1s followed by 0s: its complement plus one is a
    // power of two. 0.0.0.0 has no network bits at all.
    const inverted = (~value) & 0xFFFFFFFF;
    if (value === 0 || (inverted & (inverted + 1)) !== 0) {
        return null;
    }
    return String(new IPv4Address(value));
}

function _format_ipv6(ip) {
    // Python str(IPv6Address). (shared/ipnet.js formatIPv6 reverses the group
    // order, so format from _v here instead of String(ip).)
    const groups = [];
    for (let i = 7; i >= 0; i--) groups.push(Number((ip._v >> BigInt(i * 16)) & 0xffffn));
    let bestStart = -1, bestLen = 1;
    let curStart = -1, curLen = 0;
    for (let i = 0; i < 8; i++) {
        if (groups[i] === 0) { if (curStart < 0) curStart = i; curLen++; if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; } }
        else { curStart = -1; curLen = 0; }
    }
    const hex = groups.map((g) => g.toString(16));
    if (bestStart >= 0 && bestLen >= 2) {
        return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
    }
    return hex.join(":");
}

function _is_v4(value) {
    try {
        new IPv4Address(value);
        return true;
    } catch {
        return false;
    }
}

function _is_v6(value) {
    try {
        new IPv6Address(value);
        return true;
    } catch {
        return false;
    }
}

export function parse_ipv6_interface(value) {
    /** '2001:db8::10/64' → ('2001:db8::10', 64). None unless it is a usable host address.
     *
     * The prefix is required (PT's addIpv6Address takes it as its own argument).
     * Multicast, unspecified, loopback and link-local are refused: none of them is
     * a static unicast address a host could be given (PT derives the link-local).
     */
    const raw = (value || "").trim();
    if (!raw.includes("/") || !_isascii(raw)) {
        return null;
    }
    let ip, prefixlen;
    try {
        const idx = raw.lastIndexOf("/");
        const plen_str = raw.slice(idx + 1);
        if (!/^\d+$/.test(plen_str)) return null;
        prefixlen = parseInt(plen_str, 10);
        if (prefixlen > 128) return null;
        ip = new IPv6Address(raw.slice(0, idx));
    } catch {
        return null;
    }
    const is_unspecified = ip._v === 0n;
    if (!(1 <= prefixlen && prefixlen <= 128) || ip.is_multicast || is_unspecified
            || ip.is_loopback || ip.is_link_local) {
        return null;
    }
    return [_format_ipv6(ip), prefixlen];
}

export function validate_host_ip_config(
    device,
    {
        mode = "",
        ip = "",
        mask = "",
        gateway = "",
        dns = "",
        ipv6_mode = "",
        ipv6_gateway = "",
        ipv6_dns = "",
        ipv6_address = "",
        wait_dhcp_s = 12.0,
    } = {}
) {
    const errors = [...validate_wait_seconds(
        device, "wait_dhcp_s", wait_dhcp_s, MAX_DHCP_WAIT_S, { allow_zero: true }).errors];

    function bad(code, msg, hint = "") {
        errors.push(new PlanError({ code: code, device: device, message: msg, suggestion: hint }));
    }

    const fields = { "ip": ip, "mask": mask, "gateway": gateway, "dns": dns,
              "ipv6_gateway": ipv6_gateway, "ipv6_dns": ipv6_dns, "ipv6_address": ipv6_address };
    for (const [name, value] of Object.entries(fields)) {
        if (has_control_chars(value)) {
            bad(ErrorCode.PANEL_INVALID_CHARS, `'${name}' contains a newline.`);
        }
    }

    if (!IP_MODES.includes(mode)) {
        bad(ErrorCode.PANEL_INVALID_VALUE, `mode '${mode}' is not valid.`, "Use 'static' or 'dhcp'.");
    }
    if (!IPV6_MODES.includes(ipv6_mode)) {
        bad(ErrorCode.PANEL_INVALID_VALUE, `ipv6_mode '${ipv6_mode}' is not valid.`,
            "Use 'auto' (SLAAC) or 'off'. For a static address use ipv6_address.");
    }
    if (ipv6_address) {
        if (parse_ipv6_interface(ipv6_address) === null) {
            bad(ErrorCode.PANEL_INVALID_IP,
                `ipv6_address '${ipv6_address}' is not a usable IPv6 host address with a prefix.`,
                "Format: '2001:db8:0:1::10/64' (not multicast, loopback or link-local).");
        }
        if (ipv6_mode === "off") {
            bad(ErrorCode.PANEL_INVALID_VALUE, "ipv6_address together with ipv6_mode='off'.",
                "Drop ipv6_mode, or drop ipv6_address.");
        }
    }

    if (mode === "dhcp" && ip) {
        bad(ErrorCode.PANEL_INVALID_VALUE, "You asked for DHCP and a fixed IP at the same time.",
            "With mode='dhcp' the server assigns the IP; drop 'ip' or use mode='static'.");
    }
    if (ip) {
        if (!_is_v4(ip)) {
            bad(ErrorCode.PANEL_INVALID_IP, `'${ip}' is not a valid IPv4 address.`);
        }
        if (normalize_mask(mask) === null) {
            bad(ErrorCode.PANEL_INVALID_IP, `Mask '${mask}' is invalid or missing.`,
                "Use '255.255.255.0' or a prefix such as '24'.");
        }
    } else if (mask) {
        bad(ErrorCode.PANEL_INVALID_VALUE, "You passed a mask without an IP.");
    }

    for (const [name, value] of [["gateway", gateway], ["dns", dns]]) {
        if (value && !_is_v4(value)) {
            bad(ErrorCode.PANEL_INVALID_IP, `${name} '${value}' is not a valid IPv4 address.`);
        }
    }
    for (const [name, value] of [["ipv6_gateway", ipv6_gateway], ["ipv6_dns", ipv6_dns]]) {
        if (value && !_is_v6(value)) {
            bad(ErrorCode.PANEL_INVALID_IP, `${name} '${value}' is not a valid IPv6 address.`);
        }
    }

    if (![mode, ip, gateway, dns, ipv6_mode, ipv6_gateway, ipv6_dns, ipv6_address].some((v) => Boolean(v))) {
        bad(ErrorCode.PANEL_INVALID_VALUE, "You did not ask for any change.",
            "Pass mode, ip/mask, gateway, dns or the ipv6_* fields.");
    }

    return new ValidationResult({ errors: errors });
}
