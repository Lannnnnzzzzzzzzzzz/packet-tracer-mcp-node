// Normalizing the converged state read from PT's processes.
//
// Pure logic, no bridge — testable with the raw structs PT returns, like
// packet_trace and port_inspect. The JS lives in infrastructure/generator/state_js.py.
//
// Shapes MEASURED on PT 9 (2026-10-30) unless a comment says otherwise:
// - routing table: {routingNetworks:[{network, subnetMask, routingEntries:[{networkId,
//   subnetMask, nextHop, portName, adminDistance, metric, typeOfProtocol}]}]}, where
//   typeOfProtocol is the ASCII code of IOS's route letter (67 C, 76 L, 79 O measured).
// - OSPF neighbour: {address, areaId, backupDr, deadInterval, dr, isMaster, isVirtual,
//   option, port, priority, routerId, seqNumber, state}; state 8 = FULL.
// - ARP: {entries:[{ipAddress, macAddress, portName}]}.
// - MAC table: {entries:[{isDynamic, macAddress, port}]}.
// - STP root ID: "32769 / 0001.63BE.8468".

import { ip_network } from "../../shared/ipnet.js";
import { pyStr, pyTruthy } from "../../shared/pycompat.js";
import { nat_mode_label } from "./port_inspect.js";

// IOS's route codes. C, L and O are measured; the rest follow the same rule
// (typeOfProtocol = the letter's ASCII code) and are taken from IOS's legend.
export const PROTOCOL_NAMES = {
    "C": "connected", "L": "local", "S": "static", "R": "RIP", "D": "EIGRP",
    "O": "OSPF", "B": "BGP", "i": "IS-IS", "E": "EGP", "M": "mobile",
    "U": "per-user static", "o": "ODR", "P": "periodic downloaded static",
    "H": "NHRP", "l": "LISP",
};
export const DYNAMIC_PROTOCOLS = new Set(["O", "R", "D", "B", "i", "E", "o"]);

// OSPF neighbour states in IOS order. Only 8 (FULL) is measured; the rest follow
// the order of the state machine. An unknown value is returned as the number.
export const OSPF_STATES = {
    1: "DOWN", 2: "ATTEMPT", 3: "INIT", 4: "2WAY", 5: "EXSTART",
    6: "EXCHANGE", 7: "LOADING", 8: "FULL",
};

// CDP fills its table from neighbours' announcements (60 s timer by default), so
// right after a deploy an empty table is expected, not a fault.
export const CDP_EMPTY_HINT = ("CDP announces every 60 s by default: right after a deploy the table " +
                  "is empty; read again in a minute.");

const _NO_ADDR = ["", "0.0.0.0", null];
function _isNoAddr(v) {
    return v === "" || v === "0.0.0.0" || v === null || v === undefined;
}

// Python dict .get(key, default): default only when the key is absent.
function _getd(obj, key, def) {
    return (obj !== null && obj !== undefined && obj[key] !== undefined) ? obj[key] : def;
}
function _get(obj, key) {
    return (obj !== null && obj !== undefined && obj[key] !== undefined) ? obj[key] : null;
}
const _strCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function _int(raw) {
    /** PT sends some numbers as strings ("0" from getNatMode): normalize when it is one. */
    if (raw === undefined) return null;
    if (typeof raw === "string") {
        const t = raw.trim();
        const stripped = t.replace(/^-+/, "");
        if (stripped.length && /^\d+$/.test(stripped) && /^-?\d+$/.test(t)) {
            return parseInt(t, 10);
        }
    }
    return raw;
}

function _entries(table) {
    if (table !== null && typeof table === "object" && !Array.isArray(table)) {
        const entries = table.entries;
        return Array.isArray(entries)
            ? entries.filter((e) => e !== null && typeof e === "object" && !Array.isArray(e)) : [];
    }
    return [];
}

export function select_devices(data, device, what) {
    /** The devices that expose `what`, or the message to return to the caller.
     *
     * `data` is the reader's {found, devices:[{name, supported, ...}]}. With a named
     * device, a missing process is an answer; in a sweep the device is just skipped.
     * Returns an array, or a string message (Python list | str union).
     */
    if (!pyTruthy(_getd(data, "found", false))) {
        return (`'${device}' does not exist in the active topology. ` +
                "Use pt_query_topology to see the real names.");
    }
    const supported = (_getd(data, "devices", [])).filter((d) => pyTruthy(d.supported));
    if (pyTruthy(device) && !supported.length) {
        const withErr = (_getd(data, "devices", [])).find((d) => pyTruthy(d.error));
        const err = withErr ? withErr.error : null;
        if (pyTruthy(err)) {
            return `PT error reading ${what} on '${device}': ${pyStr(err)}`;
        }
        return (`'${device}' does not expose ${what}: wrong device type or model. ` +
                "Use pt_get_device_details to see what it is.");
    }
    return supported;
}

// ----------------------------------------------------------------------------
// Routing table
// ----------------------------------------------------------------------------

export function protocol_letter(raw) {
    /** IOS route letter from typeOfProtocol (an ASCII code, or already a letter). */
    raw = _int(raw);
    if (typeof raw === "number" && Number.isInteger(raw) && 33 <= raw && raw < 127) {
        return String.fromCharCode(raw);
    }
    if (typeof raw === "string" && raw.length === 1) {
        return raw;
    }
    return "?";
}

function _prefix(network, mask) {
    try {
        const net = ip_network(`${network}/${mask}`, false);
        if (typeof net.prefixlen !== "number" || Number.isNaN(net.prefixlen)) throw new Error("bad prefix");
        return net.toString();
    } catch {
        return pyTruthy(mask) ? `${pyStr(network ?? null)}/${pyStr(mask)}` : pyStr(pyTruthy(network) ? network : "");
    }
}

export function normalize_routes(table) {
    /** Flattens RoutingProcess.getRoutingTable() into one dict per route. */
    const routes = [];
    const nets = (table !== null && typeof table === "object" && !Array.isArray(table))
        ? table.routingNetworks : null;
    for (const net of (Array.isArray(nets) ? nets : [])) {
        if (net === null || typeof net !== "object" || Array.isArray(net)) {
            continue;
        }
        const entries = net.routingEntries;
        for (const entry of (Array.isArray(entries) ? entries : [])) {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
                continue;
            }
            const letter = protocol_letter(_get(entry, "typeOfProtocol"));
            const next_hop = _get(entry, "nextHop");
            routes.push({
                "prefix": _prefix(pyTruthy(_get(entry, "networkId")) ? _get(entry, "networkId") : _get(net, "network"),
                                  pyTruthy(_get(entry, "subnetMask")) ? _get(entry, "subnetMask") : _get(net, "subnetMask")),
                "protocol": letter,
                "protocol_name": PROTOCOL_NAMES[letter] !== undefined ? PROTOCOL_NAMES[letter] : "unknown",
                "next_hop": _isNoAddr(next_hop) ? null : next_hop,
                "interface": pyTruthy(_get(entry, "portName")) ? _get(entry, "portName") : null,
                "admin_distance": _int(_get(entry, "adminDistance")),
                "metric": _int(_get(entry, "metric")),
            });
        }
    }
    return routes;
}

export function routes_report(devices) {
    /** Per-device routes, counts by protocol and, across routers, missing prefixes. */
    const out = [];
    for (const dev of devices) {
        const routes = normalize_routes(_get(dev, "table"));
        const counts = {};
        for (const r of routes) {
            counts[r["protocol"]] = (counts[r["protocol"]] ?? 0) + 1;
        }
        const by_protocol = {};
        for (const k of Object.keys(counts).sort(_strCmp)) by_protocol[k] = counts[k];
        out.push({ "device": _get(dev, "name"), "model": _getd(dev, "model", ""),
                    "routes": routes, "by_protocol": by_protocol });
    }

    // Convergence hint: a router running a dynamic protocol should know every
    // prefix the other such routers know (unless a default route covers it).
    const gaps = [];
    const dynamic = out.filter((d) => d["routes"].some((r) => DYNAMIC_PROTOCOLS.has(r["protocol"])));
    if (dynamic.length > 1) {
        const known = (d) => new Set(d["routes"].filter((r) => r["protocol"] !== "L").map((r) => r["prefix"]));
        const union = new Set();
        for (const d of dynamic) for (const p of known(d)) union.add(p);
        for (const d of dynamic) {
            if (known(d).has("0.0.0.0/0")) {
                continue;
            }
            const missing = [...union].filter((p) => !known(d).has(p)).sort(_strCmp);
            if (missing.length) {
                gaps.push({ "device": d["device"], "missing": missing });
            }
        }
    }

    const parts = out.map((d) => `${pyStr(d["device"])}: ${d["routes"].length} route(s)` +
             (Object.keys(d["by_protocol"]).length
                ? ` (${Object.entries(d["by_protocol"]).map(([p, n]) => `${n} ${p}`).join(", ")})`
                : ""));
    let summary = parts.length ? parts.join("; ") : "No device exposes a routing table.";
    if (gaps.length) {
        summary = ("⚠ " + gaps.map((g) => `${pyStr(g["device"])} lacks ${g["missing"].length} prefix(es) ` +
                                    "other routers know").join("; ") + ". " + summary);
    }
    return { "devices": out, "convergence_gaps": gaps, "summary": summary };
}

// ----------------------------------------------------------------------------
// OSPF
// ----------------------------------------------------------------------------

export function ospf_state_name(raw) {
    /** FULL, 2WAY... for a known state; the raw value otherwise. */
    const code = _int(raw === undefined ? null : raw);
    return (code !== null && Object.prototype.hasOwnProperty.call(OSPF_STATES, code))
        ? OSPF_STATES[code] : (raw === undefined ? null : raw);
}

function _ospf_role(nb) {
    const dr = _get(nb, "dr"), bdr = _get(nb, "backupDr"), addr = _get(nb, "address");
    if (_isNoAddr(dr) && _isNoAddr(bdr)) {
        return null;  // point-to-point: no DR election
    }
    if (pyTruthy(addr) && addr === dr) {
        return "DR";
    }
    if (pyTruthy(addr) && addr === bdr) {
        return "BDR";
    }
    return "DROTHER";
}

export function normalize_ospf_neighbor(nb, local_port = "") {
    const code = _int(_get(nb, "state"));
    return {
        "router_id": _get(nb, "routerId"),
        "address": _get(nb, "address"),
        "local_port": pyTruthy(local_port) ? local_port : _get(nb, "port"),
        "state": ospf_state_name(_get(nb, "state")),
        "state_code": code,
        "role": _ospf_role(nb),
        "priority": _int(_get(nb, "priority")),
        "dead_interval": _int(_get(nb, "deadInterval")),
        "area_id": _get(nb, "areaId"),
    };
}

function _neighbor_ok(nb) {
    // 2WAY is the stable state between two DROTHERs on a shared segment.
    return nb["state"] === "FULL" || (nb["state"] === "2WAY" && nb["role"] === "DROTHER");
}

export function ospf_report(devices) {
    const out = [];
    const without = [];
    const problems = [];
    for (const dev of devices) {
        const procs = [];
        for (const pr of (dev.processes ?? [])) {
            const areas = [];
            for (const ar of (pr.areas ?? [])) {
                const nbs = (ar.neighbors ?? [])
                    .filter((w) => w !== null && typeof w === "object" && !Array.isArray(w))
                    .map((w) => normalize_ospf_neighbor(
                        (w.neighbor !== null && w.neighbor !== undefined) ? w.neighbor : {},
                        _getd(w, "local_port", "")));
                areas.push({ "area_id": _get(ar, "area_id"), "neighbors": nbs,
                              "adjacent": _getd(ar, "adjacent", 0) });
                for (const nb of nbs) {
                    if (!_neighbor_ok(nb)) {
                        problems.push({ "device": _get(dev, "name"), "neighbor": nb["router_id"],
                                         "port": nb["local_port"], "state": nb["state"] });
                    }
                }
            }
            procs.push({ "process_id": _get(pr, "process_id"), "router_id": _get(pr, "router_id"),
                          "areas": areas });
        }
        if (!procs.length) {
            without.push(_get(dev, "name"));
            continue;
        }
        let total = 0;
        for (const p of procs) for (const a of p["areas"]) total += a["neighbors"].length;
        out.push({ "device": _get(dev, "name"), "processes": procs, "neighbors": total });
    }

    const rid_owners = {};
    for (const d of out) {
        for (const p of d["processes"]) {
            if (pyTruthy(p["router_id"]) && !_isNoAddr(p["router_id"])) {
                if (!Object.prototype.hasOwnProperty.call(rid_owners, p["router_id"])) {
                    rid_owners[p["router_id"]] = [];
                }
                rid_owners[p["router_id"]].push(d["device"]);
            }
        }
    }
    const duplicates = {};
    for (const [rid, names] of Object.entries(rid_owners)) {
        if (names.length > 1) duplicates[rid] = names;
    }
    const lonely = out.filter((d) => d["neighbors"] === 0).map((d) => d["device"]);

    const total = out.reduce((s, d) => s + d["neighbors"], 0);
    let summary;
    if (!out.length) {
        summary = "No device runs an OSPF process.";
    } else if (!problems.length && !Object.keys(duplicates).length && !lonely.length) {
        summary = (`✅ ${out.length} router(s) running OSPF, ${total} neighbour(s), ` +
                   "all FULL (or 2WAY between DROTHERs).");
    } else {
        const bits = [];
        if (problems.length) {
            bits.push(`${problems.length} neighbour(s) not FULL: ` + problems.slice(0, 4)
                .map((p) => `${pyStr(p["device"])} ${pyStr(p["port"])} -> ${pyStr(p["neighbor"])} ${pyStr(p["state"])}`).join(", "));
        }
        if (Object.keys(duplicates).length) {
            bits.push("duplicate router-id " + Object.entries(duplicates)
                .map(([rid, n]) => `${rid} (${n.map((x) => pyStr(x)).join("/")})`).join(", "));
        }
        if (lonely.length) {
            bits.push("no neighbours on " + lonely.map((x) => pyStr(x)).join(", "));
        }
        summary = "⚠ " + bits.join("; ") + ".";
    }
    return { "devices": out, "not_full": problems, "duplicate_router_ids": duplicates,
            "without_neighbors": lonely, "without_ospf": without, "summary": summary };
}

// ----------------------------------------------------------------------------
// ARP / MAC / CDP
// ----------------------------------------------------------------------------

export function normalize_arp(table) {
    return _entries(table).map((e) => ({ "ip": _get(e, "ipAddress"), "mac": _get(e, "macAddress"), "port": _get(e, "portName") }));
}

export function arp_report(devices) {
    const out = devices.map((d) => ({ "device": _get(d, "name"), "entries": normalize_arp(_get(d, "table")) }));
    const total = out.reduce((s, d) => s + d["entries"].length, 0);
    const summary = out.length
        ? (`${total} ARP entr${total === 1 ? "y" : "ies"} on ${out.length} device(s): ` +
           out.map((d) => `${pyStr(d["device"])} ${d["entries"].length}`).join(", "))
        : "No device exposes an ARP table.";
    return { "devices": out, "summary": summary };
}

export function normalize_mac_table(table) {
    return _entries(table).map((e) => ({ "mac": _get(e, "macAddress"), "port": _get(e, "port"),
             "dynamic": !!pyTruthy(_get(e, "isDynamic")) }));
}

export function mac_table_report(devices) {
    const out = [];
    for (const d of devices) {
        const vlans = (d.vlans ?? []).map((v) => ({ "vlan": _get(v, "number"), "name": _get(v, "name"),
                  "entries": normalize_mac_table(_get(v, "table")) }));
        out.push({ "device": _get(d, "name"),
                    "vlans": vlans.filter((v) => v["entries"].length),
                    "macs": vlans.reduce((s, v) => s + v["entries"].length, 0) });
    }
    const summary = out.length
        ? out.map((d) => `${pyStr(d["device"])}: ${d["macs"]} MAC(s) in ${d["vlans"].length} VLAN(s)`).join("; ")
        : "No device exposes a MAC table.";
    return { "devices": out, "summary": summary };
}

const _CDP_FIELDS = {
    "deviceId": "device_id", "localPort": "local_port", "remotePort": "remote_port",
    "platform": "platform", "capability": "capability", "holdTime": "hold_time",
    "nativeVlan": "native_vlan", "cdpVersion": "cdp_version",
    "softwareVersion": "software_version",
};

export function normalize_cdp_neighbor(nb) {
    /** CdpNeighbor's fields come from Cisco's reference (never seen filled live):
     * anything unexpected is kept under `raw` instead of being dropped. */
    const out = {};
    for (const [old, nw] of Object.entries(_CDP_FIELDS)) {
        if (old in nb) out[nw] = nb[old] !== undefined ? nb[old] : null;
    }
    if (!Object.keys(out).length) {
        out["raw"] = nb;
    }
    return out;
}

export function cdp_report(devices) {
    const out = devices.map((d) => ({ "device": _get(d, "name"),
            "neighbors": (d.neighbors ?? [])
                .filter((n) => n !== null && typeof n === "object" && !Array.isArray(n))
                .map((n) => normalize_cdp_neighbor(n)) }));
    const total = out.reduce((s, d) => s + d["neighbors"].length, 0);
    let summary;
    if (!out.length) {
        summary = "No device exposes CDP.";
    } else if (total === 0) {
        summary = "All CDP tables are empty. " + CDP_EMPTY_HINT;
    } else {
        summary = `${total} CDP neighbour(s): ` + out
            .map((d) => `${pyStr(d["device"])} ${d["neighbors"].length}`).join(", ");
    }
    return { "devices": out, "summary": summary };
}

// ----------------------------------------------------------------------------
// STP
// ----------------------------------------------------------------------------

export function split_bridge_id(raw) {
    /** '32769 / 0001.63BE.8468' -> [32769, '0001.63BE.8468'] (Python tuple). */
    if (typeof raw !== "string" || !raw.includes("/")) {
        return [null, (typeof raw === "string" && pyTruthy(raw)) ? raw : null];
    }
    const idx = raw.indexOf("/");
    const prio = raw.slice(0, idx);
    const mac = raw.slice(idx + 1);
    return [/^\d+$/.test(prio.trim()) ? _int(prio.trim()) : null, pyTruthy(mac.trim()) ? mac.trim() : null];
}

export function stp_report(devices) {
    const out = [];
    const roots = new Map();   // vlan -> Set of root ids
    const claims = new Map();  // vlan -> [device names]
    for (const d of devices) {
        const insts = [];
        for (const i of (d.instances ?? [])) {
            const [prio, mac] = split_bridge_id(_get(i, "root_id"));
            const inst = { "vlan": _get(i, "vlan"), "is_root": !!pyTruthy(_get(i, "is_root")),
                    "root_id": _get(i, "root_id"), "root_priority": prio, "root_mac": mac,
                    "bridge_id": _get(i, "bridge_id"), "priority": _get(i, "priority"),
                    "root_path_cost": _get(i, "root_path_cost"), "root_port": _get(i, "root_port"),
                    "port_count": _get(i, "port_count") };
            insts.push(inst);
            if (pyTruthy(inst["root_id"])) {
                if (!roots.has(inst["vlan"])) roots.set(inst["vlan"], new Set());
                roots.get(inst["vlan"]).add(inst["root_id"]);
            }
            if (pyTruthy(inst["is_root"])) {
                if (!claims.has(inst["vlan"])) claims.set(inst["vlan"], []);
                claims.get(inst["vlan"]).push(_get(d, "name"));
            }
        }
        if (insts.length) {
            out.push({ "device": _get(d, "name"), "instances": insts });
        }
    }

    // Python sorted() on vlan keys: numeric when they are numbers.
    const _vlanCmp = (a, b) => {
        if (typeof a === "number" && typeof b === "number") return a - b;
        return _strCmp(pyStr(a ?? null), pyStr(b ?? null));
    };
    const disagreements = {};
    for (const v of [...roots.keys()].sort(_vlanCmp)) {
        const ids = roots.get(v);
        if (ids.size > 1) disagreements[v] = [...ids].sort(_strCmp);
    }
    const multi_root = {};
    for (const [v, names] of claims.entries()) {
        if (names.length > 1) multi_root[v] = names;
    }
    let summary;
    if (!out.length) {
        summary = "No switch exposes an STP instance.";
    } else if (Object.keys(disagreements).length || Object.keys(multi_root).length) {
        // Python: bits iterate sorted(disagreements.items()) / sorted(multi_root.items()).
        const bits = Object.entries(disagreements)
            .sort((a, b) => _vlanCmp(isNaN(Number(a[0])) ? a[0] : Number(a[0]), isNaN(Number(b[0])) ? b[0] : Number(b[0])))
            .map(([v, ids]) => `VLAN ${v}: ${ids.length} different root IDs`);
        bits.push(...Object.entries(multi_root)
            .sort((a, b) => _vlanCmp(isNaN(Number(a[0])) ? a[0] : Number(a[0]), isNaN(Number(b[0])) ? b[0] : Number(b[0])))
            .filter(([v]) => !(v in disagreements))
            .map(([v, n]) => `VLAN ${v}: ${n.map((x) => pyStr(x)).join(", ")} all claim root`));
        summary = "⚠ Not converged: " + bits.join("; ") + ".";
    } else {
        const per_vlan = [];
        for (const v of [...roots.keys()].sort(_vlanCmp)) {
            const owner = claims.get(v);
            per_vlan.push(`VLAN ${pyStr(v ?? null)} root ${pyStr(owner && owner.length ? owner[0] : [...roots.get(v)][0])}`);
        }
        summary = `✅ ${out.length} switch(es) agree on the root: ` + per_vlan.join(", ") + ".";
    }
    const root_by_vlan = {};
    for (const [v, ids] of roots.entries()) root_by_vlan[v] = [...ids].sort(_strCmp);
    return { "devices": out, "root_by_vlan": root_by_vlan,
            "root_disagreements": disagreements, "multiple_roots": multi_root,
            "summary": summary };
}

// ----------------------------------------------------------------------------
// ACL / NAT
// ----------------------------------------------------------------------------

export function acl_report(devices) {
    const out = [];
    const undefined_ = [];
    for (const d of devices) {
        const acls = [];
        for (const a of (d.acls ?? [])) {
            const ext = _get(a, "extended");
            acls.push({ "id": _get(a, "id"),
                         "type": (ext === null || ext === undefined) ? null : (pyTruthy(ext) ? "extended" : "standard"),
                         "commands": pyTruthy(_get(a, "commands")) ? _get(a, "commands") : [] });
        }
        const ids = new Set(acls.filter((a) => a["id"] !== null && a["id"] !== undefined).map((a) => String(a["id"])));
        const bindings = d.bindings ?? [];
        // An ACL id is only comparable when PT reported the ids (getAclId is documented,
        // not probed); without them nothing is flagged.
        if (ids.size) {
            for (const b of bindings) {
                for (const direction of ["acl_in", "acl_out"]) {
                    if (pyTruthy(b[direction]) && !ids.has(String(b[direction]))) {
                        undefined_.push({ "device": _get(d, "name"), "port": _get(b, "port"),
                                          "direction": direction.slice(4), "acl": b[direction] });
                    }
                }
            }
        }
        if (acls.length || bindings.length) {
            out.push({ "device": _get(d, "name"), "acls": acls, "bindings": bindings });
        }
    }
    const total = out.reduce((s, d) => s + d["acls"].length, 0);
    let summary = out.length
        ? (`${total} ACL(s), ` +
           `${out.reduce((s, d) => s + d["bindings"].length, 0)} port(s) with an ACL applied.`)
        : "No ACLs configured.";
    if (undefined_.length) {
        summary = (`⚠ ${undefined_.length} port(s) reference an ACL that does not exist ` +
                   "(IOS then filters nothing). " + summary);
    }
    return { "devices": out, "undefined_acls": undefined_, "summary": summary };
}

export function nat_report(devices) {
    const out = [];
    for (const d of devices) {
        let ports = (d.ports ?? []).map((p) => ({ "port": _get(p, "port"), "nat_mode": nat_mode_label(_int(_get(p, "nat_mode_raw"))) }));
        ports = ports.filter((p) => p["nat_mode"] !== "none");
        // NatTable entries were only ever seen empty: passed through as PT sends them.
        const translations = _entries(_get(d, "table"));
        const counters = {};
        for (const [k, v] of Object.entries(d.counters ?? {})) {
            if (v !== null && v !== undefined) counters[k] = v;
        }
        if (ports.length || translations.length || Object.values(counters).some((v) => pyTruthy(v))) {
            out.push({ "device": _get(d, "name"), "ports": ports, "counters": counters,
                        "translations": translations });
        }
    }
    let summary;
    if (!out.length) {
        summary = "No NAT configured.";
    } else {
        summary = out.map((d) =>
            `${pyStr(d["device"])}: ${d["translations"].length} translation(s), ` +
            `inside ${d["ports"].filter((p) => p["nat_mode"] === "inside").length}, ` +
            `outside ${d["ports"].filter((p) => p["nat_mode"] === "outside").length}`).join("; ");
        const missing = out
            .filter((d) => !d["ports"].some((p) => p["nat_mode"] === "inside")
                   || !d["ports"].some((p) => p["nat_mode"] === "outside"))
            .map((d) => d["device"]);
        if (missing.length) {
            summary = (`⚠ ${missing.map((x) => pyStr(x)).join(", ")}: NAT needs both an inside and an outside ` +
                       "interface. " + summary);
        }
    }
    return { "devices": out, "summary": summary };
}

// ----------------------------------------------------------------------------
// VLAN membership (pt_read_vlans)
// ----------------------------------------------------------------------------

export function vlans_report(dev) {
    /** pt_read_vlans' reply: the VLAN database plus who is in each VLAN. */
    const vlans = (dev.vlans ?? []).map((v) => ({ ...v }));
    const ports = dev.ports ?? [];
    const known = new Set(vlans.map((v) => _get(v, "number")));
    const by_vlan = new Map();
    const trunks = [], secured = [], orphans = [];
    for (const p of ports) {
        if (pyTruthy(p.port_security)) {
            secured.push({ "port": p["name"], ...p.port_security });
        }
        if (pyTruthy(p.access)) {
            const av = _get(p, "access_vlan");
            if (!by_vlan.has(av)) by_vlan.set(av, []);
            by_vlan.get(av).push(p["name"]);
            if (!known.has(av)) {
                orphans.push({ "port": p["name"], "vlan": av });
            }
        } else {
            trunks.push({ "port": p["name"], "native_vlan": _get(p, "native_vlan") });
        }
    }
    for (const v of vlans) {
        v["access_ports"] = by_vlan.get(_get(v, "number")) ?? [];
    }

    const custom = vlans.filter((v) => !pyTruthy(_get(v, "is_default")));
    let summary = (`${vlans.length} VLAN(s): ${custom.length} custom, ${vlans.length - custom.length} factory. ` +
               `Model maximum: ${pyStr(_get(dev, "max_vlans"))}. ` +
               `${ports.length - trunks.length} access port(s), ${trunks.length} trunk(s)` +
               (secured.length ? `, ${secured.length} with port security` : "") + ".");
    if (orphans.length) {
        summary = (`⚠ ${orphans.length} access port(s) in a VLAN missing from the database ` +
                   "(IOS leaves them inactive). " + summary);
    }
    return { "found": true, "supported": true, "max_vlans": _get(dev, "max_vlans"),
            "vlan_interfaces": _get(dev, "vlan_interfaces"), "vlans": vlans,
            "trunk_ports": trunks, "port_security": secured,
            "ports_in_missing_vlan": orphans, "summary": summary };
}

// ----------------------------------------------------------------------------
// DHCP leases (pt_read_dhcp_leases)
// ----------------------------------------------------------------------------

export function normalize_lease(raw) {
    /** {ipAddress, leaseTime, macAddress, port} (measured on a 2911) -> snake_case. */
    return { "ip": _get(raw, "ipAddress"), "mac": _get(raw, "macAddress"),
            "port": _get(raw, "port"), "lease_time": _int(_get(raw, "leaseTime")) };
}

export function dhcp_leases_report(devices) {
    /** Pools and their leases per DHCP server; flags pools whose leases are unreadable. */
    let out = [];
    for (const d of devices) {
        const pools = [], seen = new Set();
        for (const p of (d.pools ?? [])) {
            const leases = [];
            for (const raw of (p.leases ?? [])) {
                if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
                    continue;
                }
                const lease = normalize_lease(raw);
                // A Server-PT answers per port: the same pool can come back twice.
                const key = `${pyStr(_get(p, "name"))}\u0000${pyStr(lease["ip"])}\u0000${pyStr(lease["mac"])}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    leases.push(lease);
                }
            }
            pools.push({ "pool": _get(p, "name"), "server_port": _get(p, "port"),
                          "lease_api": !!pyTruthy(_get(p, "lease_api")),
                          "truncated": !!pyTruthy(_get(p, "truncated")), "leases": leases });
        }
        out.push({ "device": _get(d, "name"), "model": _getd(d, "model", ""),
                    "source": _get(d, "source"), "pools": pools,
                    "leases": pools.reduce((s, p) => s + p["leases"].length, 0) });
    }
    // A sweep lists only the devices that serve DHCP; one named device is kept as is.
    if (out.length > 1) {
        out = out.filter((d) => d["pools"].length);
    }
    const blind = [];
    for (const d of out) for (const p of d["pools"]) {
        if (!p["lease_api"]) blind.push(`${pyStr(d["device"])}/${pyStr(p["pool"])}`);
    }
    let summary;
    if (!out.some((d) => d["pools"].length)) {
        summary = "No DHCP pool found.";
    } else {
        const total = out.reduce((s, d) => s + d["leases"], 0);
        summary = `${total} lease(s): ` + out.filter((d) => d["pools"].length)
            .map((d) => `${pyStr(d["device"])} ${d["leases"]} in ${d["pools"].length} pool(s)`).join(", ");
    }
    if (blind.length) {
        summary += (` ⚠ ${blind.length} pool(s) without a lease API in this PT build ` +
                    `(${blind.join(", ")}): their leases are unknown, not zero.`);
    }
    return { "devices": out, "summary": summary };
}
