// MCP server for Packet Tracer. (Port of server.py)
//
// Entry point: creates the server, registers tools/resources, and starts
// on streamable-http (:39400) or stdio depending on the --stdio flag.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    CallToolRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { BridgeContext } from "./adapters/mcp/bridge_context.js";
import { PROMPTS, get_prompt } from "./adapters/mcp/prompt_registry.js";
import { RESOURCE_DEFS, read_resource } from "./adapters/mcp/resource_registry.js";
import { ToolRegistry, register_tools } from "./adapters/mcp/tool_registry.js";
import { SERVER_NAME, SERVER_INSTRUCTIONS } from "./settings.js";
import { reply_json } from "./shared/utils.js";

export const TRANSPORT_PORT = 39400;

const _pkg = JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8")
);
// Report OUR version in the handshake, not the SDK's.
export const __version__ = _pkg.version;

export async function build_server() {
    const server = new Server(
        { name: SERVER_NAME, version: __version__ },
        {
            capabilities: { tools: {}, resources: {}, prompts: {} },
            instructions: SERVER_INSTRUCTIONS,
        }
    );

    // One bridge for the whole server; main() starts it before serving.
    const bridge = new BridgeContext();
    const registry = new ToolRegistry();
    await register_tools(registry, bridge);

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: registry.listDefs(),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const handler = registry.handlers.get(name);
        if (!handler) {
            return {
                content: [{ type: "text", text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }
        try {
            const result = await handler(args || {});
            // FastMCP serves a str return as-is; anything else is JSON-serialised.
            const text = typeof result === "string" ? result : reply_json(result);
            return { content: [{ type: "text", text }] };
        } catch (err) {
            return {
                content: [{ type: "text", text: err && err.message ? err.message : String(err) }],
                isError: true,
            };
        }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: RESOURCE_DEFS,
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const uri = request.params.uri;
        const text = await read_resource(uri, registry);
        if (text === null) {
            throw new Error(`Unknown resource: ${uri}`);
        }
        return {
            contents: [{ uri, mimeType: "text/plain", text }],
        };
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: PROMPTS.map((p) => ({ name: p.name, description: p.description, arguments: [] })),
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const prompt = get_prompt(request.params.name);
        if (!prompt) {
            throw new Error(`Unknown prompt: ${request.params.name}`);
        }
        return {
            description: prompt.description,
            messages: [{ role: "user", content: { type: "text", text: prompt.text } }],
        };
    });

    return { server, bridge, registry };
}

export function workdir() {
    /** Where exports, screenshots and saved plans go (`PT_MCP_WORKDIR` overrides it).
     *
     * Tools write to relative folders ("projects", "screenshots"). Relative to what the
     * client launched the server from, that could be the user's home, a repo, or `/`.
     */
    const env = process.env.PT_MCP_WORKDIR;
    return env ? path.resolve(env.replace(/^~(?=$|\/|\\)/, os.homedir())) : path.join(os.homedir(), "PacketTracerMCP");
}

export async function main(argv = process.argv.slice(2)) {
    /** Starts the MCP server.
     *
     * By default uses streamable-http on :39400 (39000 belongs to Packet Tracer's own IPC).
     * With --stdio uses the stdio transport (for debugging or legacy clients).
     * `packet-tracer-mcp install-skill` installs the companion Agent Skill instead of serving.
     */
    if (argv[0] === "install-skill") {
        const { main: install_skill } = await import("./skill_install.js");
        process.exit(await install_skill(argv.slice(1)));
    }
    const wd = workdir();
    fs.mkdirSync(wd, { recursive: true });
    process.chdir(wd);
    const { server, bridge } = await build_server();
    // Listen right away, so the extension's panel is online as soon as the agent starts.
    // A busy port is not fatal: the tools report it on their first call.
    await bridge.ensure_bridge(false);
    if (argv.includes("--stdio")) {
        await server.connect(new StdioServerTransport());
    } else {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless, like FastMCP stateless_http=True
        });
        await server.connect(transport);
        const httpServer = http.createServer((req, res) => {
            transport.handleRequest(req, res);
        });
        await new Promise((resolve) => httpServer.listen(TRANSPORT_PORT, "127.0.0.1", resolve));
    }
}
