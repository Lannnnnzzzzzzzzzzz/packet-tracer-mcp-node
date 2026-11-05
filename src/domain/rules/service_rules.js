// Validation for Server-PT services and Desktop apps.
//
// The values go to Script Engine setters that validate nothing: a DHCP pool with
// a mistyped IP or a DNS record with a newline is stored and fails silently when
// a host uses it.

import { IPv4Address } from "../../shared/ipnet.js";
import { ErrorCode, PlanError, ValidationResult } from "../models/errors.js";
import { normalize_mask } from "./panel_rules.js";
import { has_control_chars } from "./text_rules.js";

export const SERVICES = ["tftp", "ftp", "syslog", "email"];
export const DNS_TYPES = ["A", "CNAME"];
export const EMAIL_ACTIONS = ["configure", "send", "receive"];
// A DNS name: dot-separated labels of letters, digits and inner hyphens.
const _DOMAIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

class _Collector {
    constructor(device) {
        this.device = device;
        this.errors = [];
    }

    bad(code, msg, hint = "") {
        this.errors.push(new PlanError({ code: code, device: this.device, message: msg, suggestion: hint }));
    }

    text(name, value) {
        if (typeof value === "string" && (has_control_chars(value) || value.includes("\x00"))) {
            this.bad(ErrorCode.PANEL_INVALID_CHARS, `'${name}' contains a newline or NUL.`);
        }
    }

    ipv4(name, value, required = false) {
        if (!value) {
            if (required) {
                this.bad(ErrorCode.PANEL_INVALID_IP, `'${name}' is missing.`);
            }
            return;
        }
        try {
            new IPv4Address(value);
        } catch {
            this.bad(ErrorCode.PANEL_INVALID_IP, `${name} '${value}' is not a valid IPv4 address.`);
        }
    }

    result() {
        return new ValidationResult({ errors: this.errors });
    }
}

export function parse_range(text) {
    /** '192.168.1.1-192.168.1.9' or a single IP → (start, end). */
    let parts = String(text).split("-").map((p) => p.trim());
    if (parts.length === 1) {
        parts = [...parts, ...parts];
    }
    if (parts.length !== 2) {
        return null;
    }
    let a, b;
    try {
        [a, b] = parts.map((p) => new IPv4Address(p));
    } catch {
        return null;
    }
    return a._int <= b._int ? [String(a), String(b)] : null;
}

export function validate_dhcp(device, { pool, gateway, dns, start_ip, mask,
                  max_users, tftp, wlc, exclude, remove_pool = "" }) {
    const c = new _Collector(device);
    c.text("pool", pool);
    c.text("remove_pool", remove_pool);
    const has_fields = [gateway, dns, start_ip, mask, max_users, tftp, wlc].some((v) => Boolean(v));
    if (remove_pool && has_fields && remove_pool.trim() === (pool || "").trim()) {
        c.bad(ErrorCode.PANEL_INVALID_VALUE,
              `remove_pool deletes '${remove_pool}' and the pool fields edit that same pool.`,
              "Delete it in one call, or edit it without remove_pool.");
    }
    for (const [name, value] of [["gateway", gateway], ["dns", dns], ["start_ip", start_ip],
                        ["tftp", tftp], ["wlc", wlc]]) {
        c.ipv4(name, value);
    }
    if (mask && normalize_mask(mask) === null) {
        c.bad(ErrorCode.PANEL_INVALID_IP, `Mask '${mask}' is invalid.`);
    }
    if (max_users < 0 || max_users > 65535) {
        c.bad(ErrorCode.PANEL_INVALID_VALUE,
              `max_users=${max_users} is out of range (1-65535, or 0 to leave it alone).`);
    }
    for (const r of exclude) {
        if (parse_range(r) === null) {
            c.bad(ErrorCode.PANEL_INVALID_IP, `Exclusion range '${r}' is invalid.`,
                  "Format: '192.168.1.1-192.168.1.9' or a single IP.");
        }
    }
    return c.result();
}

export function validate_dns(device, records, remove) {
    const c = new _Collector(device);
    for (const rec of [...records, ...remove]) {
        const name = String(rec["name"] ?? "");
        const rtype = String(rec["type"] ?? "A").toUpperCase();
        const value = String(rec["value"] ?? "");
        c.text("name", name);
        c.text("value", value);
        if (!name) {
            c.bad(ErrorCode.PANEL_INVALID_VALUE, "DNS record without a 'name'.");
        }
        if (!DNS_TYPES.includes(rtype)) {
            c.bad(ErrorCode.PANEL_INVALID_VALUE, `DNS type '${rtype}' is not supported.`,
                  "Use 'A' or 'CNAME'.");
        } else if (rtype === "A") {
            c.ipv4(`value of ${name}`, value, true);
        } else if (!value) {
            c.bad(ErrorCode.PANEL_INVALID_VALUE, `CNAME ${name} has no target.`);
        }
    }
    return c.result();
}

export function validate_users(device, service, users) {
    const c = new _Collector(device);
    if (!SERVICES.includes(service)) {
        c.bad(ErrorCode.PANEL_INVALID_VALUE, `Service '${service}' is not supported.`,
              `Use one of: ${SERVICES.join(", ")} (DHCP/DNS/HTTP have their own tools).`);
    }
    if (users.length && !["ftp", "email"].includes(service)) {
        c.bad(ErrorCode.PANEL_INVALID_VALUE, `'${service}' has no user accounts.`);
    }
    for (const u of users) {
        c.text("username", u["username"] ?? "");
        c.text("password", u["password"] ?? "");
        if (!u["username"]) {
            c.bad(ErrorCode.PANEL_INVALID_VALUE, "User without a 'username'.");
        }
        const perms = String(u["permissions"] ?? "");
        if (perms && [...perms].some((ch) => !"RWDNL".includes(ch))) {
            c.bad(ErrorCode.PANEL_INVALID_VALUE, `FTP permissions '${perms}' are invalid.`,
                  "Combine R(ead) W(rite) D(elete) N(rename) L(ist).");
        }
    }
    return c.result();
}

export function validate_email_server(device, service, { domain = "", smtp = null, pop3 = null } = {}) {
    /** The EMAIL service's Domain Name and SMTP/POP3 switches (Server-PT only). */
    const c = new _Collector(device);
    if ((domain || smtp !== null || pop3 !== null) && service !== "email") {
        c.bad(ErrorCode.PANEL_INVALID_VALUE,
              `domain/smtp/pop3 belong to the EMAIL service, not '${service}'.`,
              "Use service='email'.");
    }
    if (domain && (domain.length > 253 || !_DOMAIN.test(domain))) {
        c.bad(ErrorCode.PANEL_INVALID_VALUE, `Domain '${domain}' is not a valid domain name.`,
              "Example: 'lab.com'.");
    }
    return c.result();
}

export function validate_texts(device, fields) {
    /** Free-text fields (URL, subject, body, SSID...): control chars only where they matter. */
    const c = new _Collector(device);
    for (const [name, value] of Object.entries(fields)) {
        if (["body", "html"].includes(name)) {
            continue; // an email body or a web page does contain newlines
        }
        c.text(name, value);
    }
    return c.result();
}
