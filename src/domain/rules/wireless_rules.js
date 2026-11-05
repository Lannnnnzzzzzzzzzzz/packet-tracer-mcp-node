// Validation for an access point's wireless settings (pt_wireless_ap).
//
// `WirelessServerProcess.setSsid` and `addToMacFilterAddrList` validate nothing:
// an SSID with a newline or a mistyped MAC is stored as is and clients simply
// stop associating, with no error anywhere.

import { ErrorCode, PlanError, ValidationResult } from "../models/errors.js";
import { has_control_chars } from "./text_rules.js";

// 802.11 caps an SSID at 32 octets.
export const MAX_SSID_BYTES = 32;
const _HEX12 = /^[0-9A-Fa-f]{12}$/;

export function normalize_mac(mac) {
    /** '00:01:63:be:84:68', '00-01-63-BE-84-68' or '0001.63be.8468' → '0001.63BE.8468'.
     *
     * PT's own form (what Port.getMacAddress returns). None if it is not a MAC.
     */
    let raw = (mac || "").trim();
    for (const sep of [".", ":", "-"]) {
        raw = raw.split(sep).join("");
    }
    if (!_HEX12.test(raw)) {
        return null;
    }
    raw = raw.toUpperCase();
    return `${raw.slice(0, 4)}.${raw.slice(4, 8)}.${raw.slice(8, 12)}`;
}

export function validate_wireless_ap(device, { ssid = "", mac_list = null } = {}) {
    const errors = [];

    function bad(code, msg, hint = "") {
        errors.push(new PlanError({ code: code, device: device, message: msg, suggestion: hint }));
    }

    if (has_control_chars(device) || (device || "").includes("\x00")) {
        bad(ErrorCode.DEVICE_INVALID_NAME, "'device' contains a newline or NUL.");
    }
    if (ssid) {
        if (has_control_chars(ssid) || ssid.includes("\x00")) {
            bad(ErrorCode.PANEL_INVALID_CHARS, "'ssid' contains a newline or NUL.");
        } else if (!ssid.trim()) {
            bad(ErrorCode.PANEL_INVALID_VALUE, "'ssid' is only whitespace.");
        } else if (new TextEncoder().encode(ssid).length > MAX_SSID_BYTES) {
            bad(ErrorCode.PANEL_INVALID_VALUE,
                `SSID '${ssid}' is longer than ${MAX_SSID_BYTES} bytes (802.11 limit).`);
        }
    }
    for (const mac of mac_list || []) {
        if (normalize_mac(String(mac)) === null) {
            bad(ErrorCode.PORTSEC_INVALID_MAC, `'${mac}' is not a MAC address.`,
                "Use 0001.63BE.8468, 00:01:63:BE:84:68 or 00-01-63-BE-84-68.");
        }
    }
    return new ValidationResult({ errors: errors });
}
