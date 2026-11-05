// Send IOS config through the bridge and report what IOS really accepted.
// (Port of infrastructure/execution/ios_verify.py)
//
// The CLI tools (ACL, NAT, VLAN, STP, port-security, hardening, interface tuning)
// used to answer "Applied" once the payload was queued. `IosApplyCheck.send` is a
// drop-in `bridge_send` for their use cases: it sends the payload wrapped by
// `verified_configure_js` and waits for the per-line statuses. No answer is
// "unverified", never success.

import { IOS_STATUS, verified_configure_js } from "../generator/ios_verify_js.js";

// Typing a long config (or generating RSA keys) takes PT a few seconds.
export const APPLY_TIMEOUT_S = 30.0;

export function parse_ios_apply_result(raw) {
    /** One reply of `verified_configure_js` → verification record.
     *
     * `verification` is "verified" (every line accepted), "rejected" (IOS refused at
     * least one line), "error" (device missing, PT error, unreadable reply) or
     * "unverified" (no reply: it may or may not have been applied).
     */
    const rec = { "verification": "unverified", "rejected_lines": [], "devices": [],
                  "saved": null, "detail": "" };
    if (raw === null || raw === undefined) {
        rec["detail"] = "No answer from PT (timeout): the config may or may not be applied.";
        return rec;
    }
    if (raw.startsWith("PT_ERROR") || raw.startsWith("ERROR")) {
        rec["verification"] = "error";
        rec["detail"] = raw;
        return rec;
    }
    let devices;
    try {
        devices = JSON.parse(raw)["devices"];
    } catch (e) {
        devices = null;
    }
    if (!Array.isArray(devices) || !devices.length) {
        rec["verification"] = "error";
        rec["detail"] = `Unexpected reply from PT: ${raw.slice(0, 200)}`;
        return rec;
    }

    const missing = [];
    let saved = true;
    for (const dev of devices) {
        const name = dev["device"] ?? "?";
        rec["devices"].push(name);
        if (!dev["found"]) {
            missing.push(name);
            continue;
        }
        saved = saved && Boolean(dev["saved"]);
        for (const bad of dev["rejected"] || []) {
            const status = bad["status"];
            rec["rejected_lines"].push({
                "device": name,
                "line": bad["line"],
                "command": String(bad["command"] ?? "").trim(),
                "status": status,
                "reason": (status !== null && status !== undefined
                    && Object.prototype.hasOwnProperty.call(IOS_STATUS, status))
                    ? IOS_STATUS[status] : `status ${status}`,
                "output": String(bad["output"] ?? "").trim(),
            });
        }
    }
    rec["saved"] = missing.length < devices.length ? saved : null;
    if (missing.length) {
        rec["verification"] = "error";
        rec["detail"] = `Device(s) not found in PT: ${missing.join(", ")}.`;
    } else if (rec["rejected_lines"].length) {
        rec["verification"] = "rejected";
    } else {
        rec["verification"] = "verified";
    }
    return rec;
}

export function merge_records(records) {
    /** Several sends (e.g. switch + router for VLANs) → one record; the worst one wins. */
    if (!records.length) {
        return parse_ios_apply_result(null);
    }
    const order = ["error", "unverified", "rejected", "verified"];
    const merged = {
        "verification": records.map((r) => r["verification"])
            .reduce((a, b) => (order.indexOf(a) <= order.indexOf(b) ? a : b)),
        "rejected_lines": records.flatMap((r) => r["rejected_lines"]),
        "devices": records.flatMap((r) => r["devices"]),
        "saved": null,
        "detail": records.map((r) => r["detail"]).filter((d) => d).join(" "),
    };
    const saves = records.map((r) => r["saved"]);
    if (saves.every((s) => s !== null && s !== undefined)) {
        merged["saved"] = saves.every((s) => s);
    }
    return merged;
}

export class IosApplyCheck {
    /** A `bridge_send` that verifies: pass `.send` to the apply use cases. */

    constructor(send_and_wait, timeout = APPLY_TIMEOUT_S) {
        this._send_and_wait = send_and_wait;
        this.timeout = timeout;
        this.records = [];
    }

    async send(js_call) {
        /** Apply and record the outcome. True only when PT answered. */
        const raw = await this._send_and_wait(verified_configure_js(js_call), this.timeout);
        const rec = parse_ios_apply_result(raw);
        this.records.push(rec);
        return rec["verification"] !== "unverified";
    }

    report() {
        /** Fields merged into the tool reply: verified, verification, rejected_lines, ...
         *
         * "not_sent" when nothing went out (dry_run, invalid plan, no bridge).
         */
        if (!this.records.length) {
            return { "verified": false, "verification": "not_sent", "rejected_lines": [],
                     "saved": null, "verification_detail": "" };
        }
        const rec = merge_records(this.records);
        return {
            "verified": rec["verification"] === "verified",
            "verification": rec["verification"],
            "rejected_lines": rec["rejected_lines"],
            "saved": rec["saved"],
            "verification_detail": rec["detail"],
        };
    }
}

export function verification_summary(report) {
    /** One summary line for a tool reply built from `IosApplyCheck.report()`. */
    const state = report["verification"];
    if (state === "verified") {
        let line = "📤 Applied and verified: IOS accepted every line.";
        if (report["saved"] === false) {
            line += " ⚠ `write memory` failed: not saved to startup-config.";
        }
        return line;
    }
    if (state === "rejected") {
        const bad = report["rejected_lines"];
        const shown = bad.slice(0, 5)
            .map((b) => `${b["device"]}: '${b["command"]}' (${b["reason"]})`).join("; ");
        const more = bad.length > 5 ? ` (+${bad.length - 5} more)` : "";
        return `❌ Sent, but IOS rejected ${bad.length} line(s): ${shown}${more}.`;
    }
    if (state === "unverified") {
        return ("⚠ Sent, but PT did not answer in time: the result is UNVERIFIED. "
            + "Check with pt_cli (show running-config).");
    }
    return `❌ Not applied: ${report["verification_detail"] || "PT error"}`;
}
