// QoS read-back (pt_read_qos): policy-map classes named from the running-config.
//
// Measured on PT 9 (2026-10-30) on a 2911:
// - PolicyMapManager.getPolicyMapCount() includes "?default-policy-map?" (dropped
//   by the reader); getPolicyMapAt(i) -> getMapName, getClassCnt,
//   isPriorityConfigured, isFairQueueConfigured, getClassAt(k).
// - A policy-map class (PolicyMapQosClass) gives getPriority (kbps),
//   isBandwidthConfigured, getBandwidth, isFairQueueConfigured, isClassDefault, but
//   NOT its name (getClassName() answers the class "PolicyMapQosClass"). The classes
//   come in running-config order, so the names are taken from `show running-config`.
// - PolicyMap.toString() THROWS: never called.

import { pyStr, pyTruthy } from "../../shared/pycompat.js";

export const DEFAULT_CLASS = "class-default";

export function policy_map_classes(running_config) {
    /** {policy-map name: [class names in order]} from a running-config. */
    const out = {};
    let current = null;
    for (const line of (running_config || "").split("\n")) {
        // Python str.splitlines() also splits on \r; strip a trailing \r per line.
        const ln = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (ln.startsWith("policy-map ")) {
            const name = ln.slice("policy-map ".length).trim();
            if (!Object.prototype.hasOwnProperty.call(out, name)) out[name] = [];
            current = out[name];
        } else if (current !== null && ln.startsWith(" class ")) {
            current.push(ln.slice(" class ".length).trim());
        } else if (ln && !ln.startsWith(" ")) {
            current = null;
        }
    }
    return out;
}

function _running_text(raw) {
    /** enterCommand answers {first, second}; the config is whichever holds text. */
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        const parts = ["first", "second"].map((k) => {
            const v = raw[k];
            return pyTruthy(v) ? pyStr(v) : "";
        });
        // Python max(parts, key=count of "\n"): first maximal wins on ties.
        let best = parts[0];
        for (const p of parts) {
            if ((p.match(/\n/g) || []).length > (best.match(/\n/g) || []).length) best = p;
        }
        return best;
    }
    return pyTruthy(raw) ? pyStr(raw) : "";
}

export function name_classes(classes, names) {
    /** Give each API class its CLI name, by position.
     *
     * class-default is matched by its flag; the others by order among the
     * non-default ones. A class left without a CLI counterpart keeps name None.
     */
    const custom = names.filter((n) => n !== DEFAULT_CLASS);
    let i = 0;
    for (const cls of classes) {
        if (pyTruthy(cls.class_default)) {
            cls["name"] = DEFAULT_CLASS;
        } else {
            cls["name"] = i < custom.length ? custom[i] : null;
            i += 1;
        }
    }
    return classes;
}

function _class_view(raw) {
    const prio = raw.priority_kbps !== undefined ? raw.priority_kbps : null;
    return {
        "name": null,
        "class_default": !!pyTruthy(raw.class_default !== undefined ? raw.class_default : null),
        "priority_kbps": (typeof prio === "number" && prio > 0) ? prio : null,
        "bandwidth_kbps": pyTruthy(raw.bandwidth_configured)
            ? (raw.bandwidth !== undefined ? raw.bandwidth : null) : null,
        "fair_queue": raw.fair_queue !== undefined ? raw.fair_queue : null,
    };
}

export function qos_policy_maps(policy_maps, running_config) {
    /** Policy-maps with named classes, plus warnings when the CLI and the API disagree.
     * Returns [out, warnings] (Python tuple). */
    const text = _running_text(running_config);
    const names = policy_map_classes(text);
    const warnings = [];
    if (policy_maps.length && !text.trim()) {
        warnings.push("The running-config could not be read: class names are unknown.");
    }
    const out = [];
    for (const pm of policy_maps) {
        const classes = (pm.classes ?? []).filter(
            (c) => c !== null && typeof c === "object" && !Array.isArray(c)).map((c) => _class_view(c));
        const pmName = pyTruthy(pm.name) ? pm.name : "";
        let cli = Object.prototype.hasOwnProperty.call(names, pmName) ? names[pmName] : undefined;
        if (cli === undefined && !text.trim()) {
            cli = [];
        } else if (cli === undefined) {
            warnings.push(`policy-map ${pyStr(pm.name ?? null)} is not in the running-config: ` +
                            "its classes stay unnamed.");
            cli = [];
        }
        name_classes(classes, cli);
        const apiNames = classes.filter((c) => c["name"] !== DEFAULT_CLASS).map((c) => c["name"]);
        const cliNames = cli.filter((n) => n !== DEFAULT_CLASS);
        if (cli.length && JSON.stringify(apiNames) !== JSON.stringify(cliNames)) {
            warnings.push(`policy-map ${pyStr(pm.name ?? null)}: the API lists ${classes.length} ` +
                            `class(es), the running-config ${cli.length}; names may not line up.`);
        }
        const view = Object.fromEntries(Object.entries(pm).filter(([k]) => k !== "classes"));
        view["classes"] = classes;
        out.push(view);
    }
    return [out, warnings];
}
