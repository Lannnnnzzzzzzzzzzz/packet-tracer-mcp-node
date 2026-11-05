// MCP tool registry. (Port of adapters/mcp/tool_registry.py)
//
// Registers every tool the LLM can call. The tools live in `tools/<topic>.js`
// (one `register(registry, ctx)` each) and share one BridgeContext; the device-panel
// tools live in `device_panel_tools.js` / `desktop_service_tools.js`.
//
// Tool metadata (name, description, inputSchema) comes from tool_defs.json,
// generated from the Python server's own tool-API snapshot
// (tests/fixtures/tool_api.json, verified identical to a live tools/list), so
// the list this server serves is byte-identical to the Python one. Handlers
// are the functions the tool modules register under each name.

import fs from "node:fs";

export const TOOL_DEFS = JSON.parse(
    fs.readFileSync(new URL("./tool_defs.json", import.meta.url), "utf-8")
);

// Registration order of tools/<name>.js.
export const TOOL_MODULES = ["planning", "live", "topology", "modules", "acl", "nat", "switching", "routing", "security", "inspect", "convergence", "simulation", "canvas", "project", "services", "traffic", "wireless"];

export class ToolRegistry {
    constructor() {
        this.handlers = new Map();
    }

    /** Register a handler: async (args) => string | value. */
    tool(name, handler) {
        this.handlers.set(name, handler);
    }

    has(name) {
        return this.handlers.has(name);
    }

    /** Tool definitions for tools/list, in the Python server's registration order. */
    listDefs() {
        return TOOL_DEFS.filter((d) => this.handlers.has(d.name));
    }

    /** All registered tool names (registration order of the defs file). */
    names() {
        return TOOL_DEFS.filter((d) => this.handlers.has(d.name)).map((d) => d.name);
    }
}

export async function register_tools(registry, ctx) {
    /** Register every tool on the registry. */
    for (const name of TOOL_MODULES) {
        const mod = await import(`./tools/${name}.js`);
        await mod.register(registry, ctx);
    }
    const { register_device_panel_tools } = await import("./device_panel_tools.js");
    await register_device_panel_tools(
        registry,
        (js, t) => ctx.send_and_wait(js, t),
        () => ctx.check_bridge(),
    );
}
