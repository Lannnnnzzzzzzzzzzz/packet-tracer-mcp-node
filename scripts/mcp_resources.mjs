// Reads all pt:// resources from any MCP server command over stdio and
// prints {uri: text} JSON for cross-server comparison.
// Usage: node test/mcp_resources.mjs <cmd> [args...]
import { spawn } from "node:child_process";

const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, PT_MCP_WORKDIR: "/tmp/pt-mcp-resources" },
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
await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "resource-test", version: "0.0.0" },
});
notify("notifications/initialized", {});
const list = await send("resources/list", {});
const out = {};
for (const r of list.resources) {
    const read = await send("resources/read", { uri: r.uri });
    out[r.uri] = read.contents.map((c) => c.text ?? "").join("\n");
}
clearTimeout(timeout);
child.kill();
console.log(JSON.stringify(out, null, 1));
