// Minimal MCP stdio client: initialize + tools/list + prompts/list +
// resources/list against any server command, prints a JSON summary.
// Usage: node test/mcp_handshake.mjs <cmd> [args...]
// Env: PT_MCP_BRIDGE_TOKEN should be set by the caller (same for both servers).
import { spawn } from "node:child_process";

const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, PT_MCP_WORKDIR: "/tmp/pt-mcp-handshake" },
});

let buffer = "";
const pending = new Map();
let nextId = 1;

function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
}
function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
        }
    }
});

const timeout = setTimeout(() => { console.error("TIMEOUT"); child.kill(); process.exit(2); }, 60000);

const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "handshake-test", version: "0.0.0" },
});
notify("notifications/initialized", {});
const tools = await send("tools/list", {});
const prompts = await send("prompts/list", {});
const resources = await send("resources/list", {});
clearTimeout(timeout);
child.kill();

console.log(JSON.stringify({
    serverInfo: init.serverInfo,
    instructions_len: (init.instructions || "").length,
    tools_count: tools.tools.length,
    tools: tools.tools,
    prompts: prompts.prompts,
    resources: resources.resources,
}, null, 1));
