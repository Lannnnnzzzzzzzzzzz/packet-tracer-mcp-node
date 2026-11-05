// Wireless tools: an access point's SSID, broadcast and MAC filter.

import { normalize_mac, validate_wireless_ap } from "../../../domain/rules/wireless_rules.js";
import { wireless_ap_js } from "../../../infrastructure/generator/wireless_js.js";
import { pyTruthy } from "../../../shared/pycompat.js";
import { reply_json } from "../../../shared/utils.js";
import { errors_text, parse_panel_reply } from "../panel_support.js";


function _comparable(field, value) {
    /** A setting in a form that compares equal however PT spells it. */
    if (field === "mac_list" && value !== null && value !== undefined) {
        return value.map((m) => normalize_mac(String(m)) || String(m)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    return value;
}

function _eq(a, b) {
    // Python == on lists/dicts/scalars.
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((x, i) => _eq(x, b[i]));
    }
    return a === b;
}


export function wireless_ap_report(device, requested, data) {
    /** What pt_wireless_ap answers: the state read back, and what moved or did not. */
    const before = data["before"] || {}, after = data["after"] || {};
    const out = {"device": device, "dry_run": Boolean(data["dry_run"]), "requested": requested};
    const differs = {};
    for (const [f, v] of Object.entries(requested)) {
        if (!_eq(_comparable(f, before[f] !== undefined ? before[f] : null), _comparable(f, v))) {
            differs[f] = {"from": before[f] !== undefined ? before[f] : null, "to": v};
        }
    }
    if (out["dry_run"]) {
        out["would_change"] = differs;
        out["state"] = before;
        out["summary"] = (`${device}: dry run, ${Object.keys(differs).length} setting(s) would change`
                          + (Object.keys(differs).length ? ` (${Object.keys(differs).join(", ")}).` : "."));
        return out;
    }
    const not_applied = Object.entries(requested).filter(([f, v]) => !_eq(_comparable(f, after[f] !== undefined ? after[f] : null), _comparable(f, v))).map(([f]) => f);
    out["applied"] = data["applied"] !== undefined && data["applied"] !== null ? data["applied"] : [];
    out["changed"] = Object.keys(requested).filter((f) => !_eq(_comparable(f, before[f] !== undefined ? before[f] : null), _comparable(f, after[f] !== undefined ? after[f] : null)));
    out["state"] = after;
    if (pyTruthy(data["failed"])) {
        out["failed"] = data["failed"];
    }
    if (!Object.keys(requested).length) {
        out["summary"] = `${device}: SSID '${after['ssid'] !== undefined && after['ssid'] !== null ? after['ssid'] : "None"}' (read only, nothing requested).`;
    } else if (not_applied.length) {
        out["not_applied"] = not_applied;
        out["summary"] = `⚠ ${device}: ${not_applied.join(", ")} did not read back as requested.`;
    } else {
        const reset = out["applied"].includes("reset_associations") ? " Associations reset: clients re-associate against the new settings." : "";
        out["summary"] = `${device}: SSID '${after['ssid'] !== undefined && after['ssid'] !== null ? after['ssid'] : "None"}', settings read back as requested.${reset}`;
    }
    return out;
}

export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */

    registry.tool("pt_wireless_ap", async (args) => {
        const device = args.device;
        const ssid = args.ssid !== undefined ? args.ssid : "";
        const broadcast = args.broadcast !== undefined ? args.broadcast : null;
        const mac_filter = args.mac_filter !== undefined ? args.mac_filter : null;
        const allow_listed = args.allow_listed !== undefined ? args.allow_listed : null;
        const mac_list = args.mac_list !== undefined ? args.mac_list : null;
        const reset_associations = args.reset_associations !== undefined ? args.reset_associations : true;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const macs = mac_list === null ? null : mac_list.map((m) => normalize_mac(String(m)) || String(m));
        const v = validate_wireless_ap(device, {ssid: ssid, mac_list: mac_list});
        if (!v.is_valid) {
            return errors_text(v);
        }
        const err = await ctx.check_bridge();
        if (err) {
            return err;
        }
        const requested = {};
        for (const [k, val] of [
            ["ssid", ssid || null], ["broadcast", broadcast], ["mac_filter", mac_filter],
            ["allow_listed", allow_listed], ["mac_list", macs]]) {
            if (val !== null && val !== undefined) requested[k] = val;
        }
        const js = wireless_ap_js(device, {ssid: ssid, broadcast: broadcast, mac_filter: mac_filter,
                            allow_listed: allow_listed, mac_list: macs,
                            reset_associations: reset_associations, dry_run: dry_run});
        const [data, error] = parse_panel_reply(await ctx.send_and_wait(js, 10.0), device);
        if (error) {
            return error;
        }
        return reply_json(wireless_ap_report(device, requested, data));
    });
}
