// Registry of MCP Resources. (Port of adapters/mcp/resource_registry.py)
//
// Defines static resources that the LLM can query.

import { ALL_MODELS, ALL_MODELS_ORDER } from "../../infrastructure/catalog/devices.js";
import { CABLE_TYPES } from "../../infrastructure/catalog/cables.js";
import { MODEL_ALIASES, MODEL_ALIASES_ORDER } from "../../infrastructure/catalog/aliases.js";
import { pyJsonDumps } from "../../shared/pycompat.js";

// Compact JSON with an explicit key order: model/alias names include
// integer-like keys ("802", "1841") that JS objects always iterate
// numerically first, while Python dicts (and its json.dumps) keep insertion
// order. Serializing entry-by-entry is the only way to match the bytes.
function ordered_json(entries) {
    const parts = entries.map(([k, v]) =>
        pyJsonDumps(String(k), { ensureAscii: false, separators: [",", ":"] })
        + ":"
        + pyJsonDumps(v, { ensureAscii: false, separators: [",", ":"] }));
    return "{" + parts.join(",") + "}";
}
import { list_templates } from "../../infrastructure/catalog/templates.js";
import { CAPABILITIES } from "../../shared/constants.js";
import { reply_json } from "../../shared/utils.js";
import { GUIDE } from "../../settings.js";

export const RESOURCE_DEFS = [
    { uri: "pt://catalog/devices", name: "resource_device_catalog", description: "Full catalog of devices available in Packet Tracer.", mimeType: "text/plain" },
    { uri: "pt://catalog/cables", name: "resource_cable_catalog", description: "Cable types available in Packet Tracer.", mimeType: "text/plain" },
    { uri: "pt://catalog/aliases", name: "resource_aliases", description: "Common aliases for device models.", mimeType: "text/plain" },
    { uri: "pt://catalog/templates", name: "resource_templates", description: "Available topology templates with descriptions.", mimeType: "text/plain" },
    { uri: "pt://guide", name: "resource_guide", description: "Full usage guide: every rule, verified PT API fact and recipe (the short\n        server instructions point here).", mimeType: "text/plain" },
    { uri: "pt://capabilities", name: "resource_capabilities", description: "Server capabilities and version.\n\n        DERIVED from the live tool registry: instead of keeping a hand-maintained list\n        that can drift (it used to say nat=\"unsupported\" while pt_apply_nat\n        existed), it introspects the tools that are actually registered and reports\n        the support of each feature based on whether its tool exists. If introspection\n        fails for any reason, it falls back to the static CAPABILITIES values.\n        ", mimeType: "text/plain" },
];

/** Read a resource by URI. `registry` is the ToolRegistry (for pt://capabilities). */
export async function read_resource(uri, registry) {
    switch (uri) {
        case "pt://catalog/devices": {
            /** Full catalog of devices available in Packet Tracer. */
            const entries = ALL_MODELS_ORDER.map((name) => {
                const model = ALL_MODELS[name];
                return [name, {
                    "display_name": model.display_name,
                    "category": model.category,
                    "ports": model.ports.map((p) => p.full_name),
                }];
            });
            return ordered_json(entries);
        }
        case "pt://catalog/cables":
            /** Cable types available in Packet Tracer. */
            return reply_json(CABLE_TYPES);
        case "pt://catalog/aliases":
            /** Common aliases for device models. */
            return ordered_json(MODEL_ALIASES_ORDER.map((a) => [a, MODEL_ALIASES[a]]));
        case "pt://catalog/templates": {
            /** Available topology templates with descriptions. */
            const templates = list_templates();
            const data = [];
            for (const t of templates) {
                data.push({
                    "name": t.name,
                    "key": t.key,
                    "description": t.description,
                    "routers": `${t.min_routers}-${t.max_routers}`,
                    "default_routing": t.default_routing,
                    "tags": [...t.tags],
                });
            }
            return reply_json(data);
        }
        case "pt://guide":
            /** Full usage guide: every rule, verified PT API fact and recipe (the short
             * server instructions point here). */
            return GUIDE;
        case "pt://capabilities": {
            /** Server capabilities and version.
             *
             * DERIVED from the live tool registry: instead of keeping a hand-maintained list
             * that can drift (it used to say nat="unsupported" while pt_apply_nat
             * existed), it introspects the tools that are actually registered and reports
             * the support of each feature based on whether its tool exists. If introspection
             * fails for any reason, it falls back to the static CAPABILITIES values.
             */
            const caps = { ...CAPABILITIES };
            try {
                const names = [...registry.names()].sort();
                caps["tools_count"] = names.length;
                caps["tools"] = names;
                // Feature → support derived from whether the tool actually exists (no drift possible)
                caps["supported_live"] = {
                    "nat": names.some((n) => n.startsWith("pt_apply_nat")),
                    "acl": names.some((n) => n.startsWith("pt_apply_acl")),
                    "modules": names.some((n) => n.includes("module")),
                    "live_deploy": names.includes("pt_live_deploy"),
                    "raw_js": names.includes("pt_send_raw"),
                    // DHCP on a Server-PT (Services > DHCP); a router's goes through the CLI.
                    "dhcp_server_pools": names.includes("pt_configure_dhcp_server"),
                };
            } catch (e) {
                // fall back to the static CAPABILITIES values
            }
            return reply_json(caps);
        }
        default:
            return null;
    }
}
