// Topology diff and health check: they compare the plan against PT's live topology
// (structured output of _live_devices: [{name, model, ports:[{name,ip,mask,up,linked}]}]).
// Pure logic, no bridge — testable with synthetic dicts.

import { resolve_model } from "../../infrastructure/catalog/devices.js";
import { pyTruthy } from "../../shared/pycompat.js";

// Categories whose ports NEVER carry an IP: they are layer 2 or transparent. An
// access port on a 2960, the ports of an AP, and the cloud's Ethernet6 used to show
// up as "cabled without IP" on every sweep, and that noise hid the only
// case that matters: the host that never got a DHCP address.
//
// It is resolved by model against the catalog, not by getClassName(): PT classifies
// by behavior, so a 3560 answers "Router" and a 2960 "CiscoDevice"
// -- none of them ever says "switch".
const _L2_CATEGORIES = new Set([
    "switch", "accesspoint", "hub", "bridge", "repeater", "cloud",
    "modem", "splitter", "patch_panel", "wall_mount", "cell_tower",
    "power_dist", "sniffer",
]);

const _strCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function _getd(obj, key, def) {
    return (obj !== null && obj !== undefined && obj[key] !== undefined) ? obj[key] : def;
}

function _carries_ip(model_name) {
    /** True if a port of this model is expected to have an IP.
     *
     * A model that does not resolve is reported anyway: better a false positive than
     * silencing a host with no address.
     */
    const model = resolve_model(model_name || "");
    if (model === null || model === undefined) {
        return true;
    }
    return !_L2_CATEGORIES.has(model.category);
}

function _is_ip_phone(model_name) {
    /** IP phones keep their address on Vlan1; the Switch and PC jacks are layer 2. */
    const model = resolve_model(model_name || "");
    return model !== null && model !== undefined && model.category === "ip_phone";
}

function _is_power_distribution(model_name) {
    const model = resolve_model(model_name || "");
    return model !== null && model !== undefined && model.category === "power_dist";
}

export function diff(plan, live) {
    /** Compares the plan against the live topology. Reports divergences. */
    const plan_devices = new Map();
    for (const d of plan.devices) plan_devices.set(d.name, d);
    const plan_names = new Set(plan_devices.keys());
    const live_by_name = new Map();
    for (const d of live) live_by_name.set(d.name !== undefined ? d.name : null, d);
    const live_names = new Set(live_by_name.keys());

    const missing_devices = [...plan_names].filter((n) => !live_names.has(n)).sort(_strCmp);
    // in PT, not in the plan. PT's own power-distribution device is not drift: it sits
    // far off the canvas and nobody placed it.
    const extra_devices = [...live_names]
        .filter((n) => !plan_names.has(n)
            && !_is_power_distribution(_getd(live_by_name.get(n), "model", "")))
        .sort(_strCmp);

    const ip_mismatches = [];
    const both = [...plan_names].filter((n) => live_names.has(n)).sort(_strCmp);
    for (const name of both) {
        const pd = plan_devices.get(name);
        const live_ips = new Map();
        for (const p of (live_by_name.get(name).ports ?? [])) {
            live_ips.set(p.name !== undefined ? p.name : null, _getd(p, "ip", null) || "");
        }
        for (const [iface, cidr] of Object.entries(pd.interfaces)) {
            const planned_ip = cidr.split("/")[0];
            const actual = live_ips.has(iface) ? live_ips.get(iface) : "";
            if (pyTruthy(actual) && actual !== "0.0.0.0" && actual !== planned_ip) {
                ip_mismatches.push({
                    "device": name, "interface": iface,
                    "planned": planned_ip, "actual": actual,
                });
            }
        }
    }

    return {
        "missing_devices": missing_devices,
        "extra_devices": extra_devices,
        "ip_mismatches": ip_mismatches,
        "in_sync": !missing_devices.length && !extra_devices.length && !ip_mismatches.length,
        "plan_device_count": plan_names.size,
        "live_device_count": live_names.size,
    };
}

export function health_check(live) {
    /** Health sweep over the live topology. */
    const down_links = [];
    const unconfigured = [];
    const ip_owners = {};

    for (const d of live) {
        const name = _getd(d, "name", "?");
        const phone = _is_ip_phone(_getd(d, "model", ""));
        const expects_ip = _carries_ip(_getd(d, "model", "")) && !phone;
        const ports = d.ports ?? [];
        if (phone && ports.some((p) => pyTruthy(p.linked))) {
            const vlan1 = ports.find((p) => p.name === "Vlan1") ?? {};
            if (["", "0.0.0.0"].includes(_getd(vlan1, "ip", null) || "")) {
                unconfigured.push({ "device": name, "port": "Vlan1" });
            }
        }
        for (const p of ports) {
            const pname = _getd(p, "name", "?");
            const ip = _getd(p, "ip", null) || "";
            const linked = !!pyTruthy(p.linked);
            const up = !!pyTruthy(p.up);
            if (linked && !up) {
                down_links.push({ "device": name, "port": pname });
            }
            if (linked && ["", "0.0.0.0"].includes(ip) && expects_ip) {
                unconfigured.push({ "device": name, "port": pname });
            }
            if (pyTruthy(ip) && ip !== "0.0.0.0") {
                if (!Object.prototype.hasOwnProperty.call(ip_owners, ip)) ip_owners[ip] = [];
                ip_owners[ip].push(`${name}:${pname}`);
            }
        }
    }

    const duplicate_ips = {};
    for (const [ip, owners] of Object.entries(ip_owners)) {
        if (owners.length > 1) duplicate_ips[ip] = owners;
    }

    const healthy = !down_links.length && !Object.keys(duplicate_ips).length;
    return {
        "healthy": healthy,
        "down_links": down_links,
        "cabled_without_ip": unconfigured,
        "duplicate_ips": duplicate_ips,
    };
}
