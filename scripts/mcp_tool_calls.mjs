// Runs a fixed battery of tools/call requests (test/tool_calls.json, generated
// alongside this file's first use) against any MCP server command over stdio
// and prints [{name, isError, text}] as JSON for cross-server comparison.
// Usage: node test/mcp_tool_calls.mjs <calls.json> <cmd> [args...]
import { spawn } from "node:child_process";
import fs from "node:fs";

const [callsPath, cmd, ...args] = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(callsPath, "utf-8"));
const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, PT_MCP_WORKDIR: "/tmp/pt-mcp-toolcalls" },
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

const timeout = setTimeout(() => { console.error("TIMEOUT"); child.kill(); process.exit(2); }, 120000);
await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "toolcall-test", version: "0.0.0" },
});
notify("notifications/initialized", {});

const results = [];
for (const [name, arguments_] of calls) {
    try {
        const r = await send("tools/call", { name, arguments: arguments_ });
        results.push({
            name,
            isError: !!r.isError,
            text: (r.content || []).map((c) => c.text ?? "").join("\n"),
        });
    } catch (e) {
        results.push({ name, isError: true, text: `RPC-ERROR: ${e.message}` });
    }
}
clearTimeout(timeout);
child.kill();
console.log(JSON.stringify(results, null, 1));
