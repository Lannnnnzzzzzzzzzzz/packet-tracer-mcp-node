// Text views of a live topology snapshot (pt_query_topology / pt_export_topology).
//
// Pure logic: the input is what `infrastructure/generator/topology_js.topology_snapshot_js`
// reports, `{device_count, link_count, devices:[...], links:[...]}`.

import { cable_type_name } from "../../infrastructure/catalog/cables.js";
import { pyStr, pyTruthy } from "../../shared/pycompat.js";

// Python dict .get(key, default): default only when the key is absent.
function _getd(obj, key, def) {
    return (obj !== null && obj !== undefined && obj[key] !== undefined) ? obj[key] : def;
}

function _isDict(e) {
    return e !== null && typeof e === "object" && !Array.isArray(e);
}

function _end(e) {
    if (!_isDict(e)) {
        return "?";
    }
    return `${pyStr(_getd(e, "device", "?"))}:${pyStr(_getd(e, "port", "?"))}`;
}

export function link_line(link) {
    /** 'R1:Gi0/0  <--[straight]-->  SW1:Fa0/1', the wireless signal, or the raw failure. */
    if (pyTruthy(link.wireless)) {
        return `${_end(link.a ?? null)}  )))  [wireless signal]`;
    }
    if (pyTruthy(link.error) || !("b" in link)) {
        return `UNKNOWN:${pyStr(pyTruthy(link.cls) ? link.cls : "?")} (${pyStr(_getd(link, "error", "no endpoints"))})`;
    }
    const cable = cable_type_name(link.cable_raw !== undefined ? link.cable_raw : null) || "unknown";
    const cableName = pyTruthy(cable) ? cable : "unknown";
    return `${_end(link.a ?? null)}  <--[${cableName}]-->  ${_end(link.b ?? null)}`;
}

export function format_query(data) {
    /** Devices with their addressed ports, then every link with its real cable type. */
    const out = [`DEVICES:${pyStr(_getd(data, "device_count", "?"))}|LINKS:${pyStr(_getd(data, "link_count", "?"))}`, ""];
    for (const d of (data.devices ?? [])) {
        const ports = (d.ports ?? []).map((p) => pyTruthy(p.ip)
            ? `${p["name"]}=${p["ip"]}/${p["mask"]}`
            : _getd(p, "name", "?"));
        const info = ports.length ? `  (${ports.join(",")})` : "";
        out.push(`  ${pyStr(_getd(d, "name", "?")).padEnd(20)} [${pyStr(_getd(d, "model", "?"))}]${info}`);
    }
    const links = data.links ?? [];
    if (links.length) {
        out.push("", "  Links:", ...links.map((l) => `    ${link_line(l)}`));
    }
    return out.join("\n");
}

export function format_export(data) {
    /** Devices with position, addressed or cabled ports, then links with cable type. */
    const out = [`=== Topology Export: ${pyStr(_getd(data, "device_count", "?"))} devices, ` +
           `${pyStr(_getd(data, "link_count", "?"))} links ===`, ""];
    for (const d of (data.devices ?? [])) {
        out.push(`  ${pyStr(_getd(d, "name", "?"))} [${pyStr(_getd(d, "model", "?"))}] @ ` +
                   `(${pyStr(_getd(d, "x", "?"))}, ${pyStr(_getd(d, "y", "?"))})`);
        for (const p of (d.ports ?? [])) {
            const ip = pyTruthy(p.ip) ? ` IP=${p["ip"]}/${p["mask"]}` : "";
            const linked = pyTruthy(p.linked) ? " [linked]" : "";
            if (ip || linked) {
                out.push(`    ${_getd(p, "name", "?")}${ip}${linked}`);
            }
        }
    }
    out.push("", "--- Links ---", ...(data.links ?? []).map((l) => `  ${link_line(l)}`));
    return out.join("\n");
}
