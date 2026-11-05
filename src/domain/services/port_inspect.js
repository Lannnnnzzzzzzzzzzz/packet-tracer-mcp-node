// Summary of the live port inspection of PT.
//
// Pure logic, no bridge — testable with synthetic dicts, same as topology_diff.
//
// The per-port detail is returned by the bridge reader; here we only aggregate and
// flag the anomalies a human would look at first. pt_health_check already covers the
// sweep of the whole topology (dropped links, duplicate IPs): this is the detail view
// of ONE device, so it does not repeat those global checks.

import { pyStr, pyTruthy } from "../../shared/pycompat.js";

// Verified against PT 9.0.0.0810: getNatMode() returns 0 on a clean port and
// 1 after `ip nat inside`. 2 is the only remaining value in IOS (`ip nat
// outside`) — inferred, not observed.
export const NAT_MODES = { 0: "none", 1: "inside", 2: "outside" };

export function nat_mode_label(raw) {
    /** Human-readable label for the NAT mode; passes the raw value through if a new one appears. */
    // A live probe on PT 9 (2026-10-30) got the string "0" from RouterPort.getNatMode().
    if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
        raw = parseInt(raw.trim(), 10);
    }
    return Object.prototype.hasOwnProperty.call(NAT_MODES, raw)
        ? NAT_MODES[raw] : `unknown(${pyStr(raw === undefined ? null : raw)})`;
}

export function summarize_ports(devices) {
    /** Aggregates the per-port detail and flags anomalies.
     *
     * `devices` is [{name, model, ports: [{name, up, linked, ip, ...}]}].
     */
    let total = 0;
    let up = 0;
    let linked = 0;
    const anomalies = [];

    for (const dev of devices) {
        const dname = dev.name !== undefined ? dev.name : "?";
        for (const port of (dev.ports ?? [])) {
            total += 1;
            const p_up = !!pyTruthy(port.up);
            const p_linked = !!pyTruthy(port.linked);
            if (p_up) {
                up += 1;
            }
            if (p_linked) {
                linked += 1;
            }

            const pname = port.name !== undefined ? port.name : "?";
            // Cable plugged in but the port does not come up: the classic symptom of a
            // forgotten `shutdown` or of the wrong cable type.
            if (p_linked && !p_up) {
                let detail = "Cabled but the port is down (shutdown, or the wrong cable?).";
                if (pyTruthy(port.cable)) {
                    // The real cable (Link.getConnectionType), so the "wrong
                    // cable" half can be checked instead of guessed.
                    detail += ` Cable: ${port.cable}` + (
                        pyTruthy(port.peer) ? ` to ${port.peer}.` : ".");
                }
                anomalies.push({
                    "device": dname, "port": pname, "issue": "linked_but_down",
                    "detail": detail,
                });
            }
            // Layer 1 up but protocol down: encapsulation or keepalive.
            else if (p_up && !pyTruthy(port.protocol_up !== undefined ? port.protocol_up : true)) {
                anomalies.push({
                    "device": dname, "port": pname, "issue": "protocol_down",
                    "detail": "Line up but protocol down (encapsulation or keepalive).",
                });
            }
        }
    }

    return {
        "devices_inspected": devices.length,
        "ports_total": total,
        "ports_up": up,
        "ports_linked": linked,
        "anomalies": anomalies,
    };
}
