# Packet Tracer MCP — Node.js port

An MCP server for Cisco Packet Tracer: topology planning, validation,
auto-fix, JS/CLI generation, and live deployment into a running Packet Tracer
over a local HTTP bridge (plus a file-mailbox fallback channel).

This is a **faithful Node.js port** of
[Mats2208/MCP-Packet-Tracer](https://github.com/Mats2208/MCP-Packet-Tracer)
(Python, MIT). Tool names, parameter schemas, descriptions, bridge protocol,
token rules and generated Packet Tracer JavaScript match the Python original;
see `PORTING_STATUS.md` for the per-module ledger and the golden-test results.

## Install

```bash
npm install
```

Requires Node.js >= 20. No other dependencies besides
`@modelcontextprotocol/sdk`.

## Run

```bash
npm start            # stdio transport (for MCP clients)
node src/index.js    # streamable HTTP on 127.0.0.1:39400 (like the Python default)
node src/index.js --stdio
```

On startup the server creates its working directory
(`PT_MCP_WORKDIR`, default `~/PacketTracerMCP`), switches into it, and starts
the Packet Tracer bridge on port **54321**.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PT_MCP_BRIDGE_TOKEN` | *(token file)* | Shared secret between server and the PT extension. Must be >= 32 chars from `[A-Za-z0-9_-]`; an unusable value is a hard startup error, exactly like upstream. When unset, a random token is generated once and persisted (Windows: `%LOCALAPPDATA%\packet-tracer-mcp\bridge_token`; POSIX: `$XDG_STATE_HOME/packet-tracer-mcp/bridge_token` or `~/.local/state/packet-tracer-mcp/bridge_token`). |
| `PT_MCP_BRIDGE_HOST` | `127.0.0.1` | **Port-only addition.** Bind address for the bridge; the configured `host:port` is automatically added to the bridge's Host allowlist. Unset ⇒ behaviour identical to upstream. |
| `PT_MCP_WORKDIR` | `~/PacketTracerMCP` | Where exports, screenshots and saved plans go. |
| `PT_MCP_UI_MODE` | `headless` | Device-panel presentation mode (`headless` \| `ui`); a saved mode file next to the token wins over the variable. |

## How the extension connects

Packet Tracer stays on your machine; only the MCP server is in this repo.

1. Install the **MCP Control Center** extension into Packet Tracer from the
   upstream releases (the extension in `extension/` here is an unchanged copy
   of upstream's `EXTENSION/` folder: `script-engine/` + `webview/`).
2. Open Packet Tracer and the extension (Extensions > MCP BUILDER). With the
   window open it polls the bridge over HTTP; with the window closed, the
   Script Engine keeps working through the file mailbox next to the token
   file. There is nothing to pair: the extension reads the token file itself.
3. Check `pt_bridge_status` from your MCP client; then `pt_full_build` or the
   plan → validate → deploy flow.

## Remote use (e.g. Tailscale)

Upstream binds the bridge to loopback only, on purpose. This port adds one
config knob for the common "server on another machine" setup:

```bash
PT_MCP_BRIDGE_HOST=100.x.y.z node src/index.js --stdio
```

With the host set to the machine's Tailscale IP, the bridge listens only on
that interface and accepts that `Host` — nothing is exposed on other
interfaces, and every request still needs the bridge token. Point the
extension's bridge address at the same host and port.

## Tests

```bash
npm test                     # bridge integration tests (node --test)
node scripts/mcp_handshake.mjs node src/index.js --stdio   # MCP handshake / tools list
node scripts/mcp_tool_calls.mjs <calls.json> node src/index.js --stdio
node scripts/mcp_resources.mjs node src/index.js --stdio
# Golden tests (JS generators vs the Python original):
#   /tmp/ptpy/bin/python scripts/golden_py.py  > py.json
#   node scripts/golden_node.mjs               > node.json
#   python3 scripts/golden_compare.py py.json node.json
```

## Layout

Mirrors the Python package: `src/domain` (models, rules, services),
`src/application` (dto, use_cases), `src/infrastructure` (catalog, execution,
generator, persistence, ui), `src/adapters/mcp` (server registries and
tools), `src/shared`.

## License

MIT — see `LICENSE`. Original Python implementation © Mats2208
(https://github.com/Mats2208/MCP-Packet-Tracer); this port keeps the same
license and attribution.
