# Setup on Windows (with Claude Code)

End-to-end install: MCP server (this repo) + Packet Tracer extension +
Claude Code as the MCP client. Everything is downloaded from this repo.

## 0. Prerequisites

- **Cisco Packet Tracer 8.2 or newer** installed (upstream requirement: 8.2+; verified end to end on 9.0.1).
- **Node.js >= 20** — check with `node -v`. If missing, install the LTS
  from https://nodejs.org, then reopen your terminal.
- **Git** — check with `git --version`. If missing: https://git-scm.com.
- **Claude Code** — check with `claude --version`. If missing:
  `npm install -g @anthropic-ai/claude-code`.

## 1. Clone and install the server

```bat
git clone https://github.com/Lannnnnzzzzzzzzzzz/packet-tracer-mcp-node.git
cd packet-tracer-mcp-node
npm install
```

Remember this folder's full path; you need it in step 3.

## 2. Install the Packet Tracer extension

1. Download **MCP-Control-Center.pts** from this repo's
   [v0.11.0 release](https://github.com/Lannnnnzzzzzzzzzzz/packet-tracer-mcp-node/releases/tag/v0.11.0).
2. Create a subfolder `MCPControlCenter` inside Packet Tracer's
   `extensions` folder (default install location shown; admin rights are
   required, Explorer will ask):

   ```
   C:\Program Files\Cisco Packet Tracer <version>\extensions\MCPControlCenter\
   ```

3. Put `MCP-Control-Center.pts` in that subfolder.
4. Restart Packet Tracer. It reports a new script module — click **Yes**.
5. Open **Extensions > MCP BUILDER** so the MCP Control Center window is up.

## 3. Register the server in Claude Code

```bat
claude mcp add packet-tracer -- node "C:\Users\<you>\packet-tracer-mcp-node\src\index.js" --stdio
```

Replace the path with your real clone location from step 1. Verify with:

```bat
claude mcp list
```

`packet-tracer` should show as connected. You never start the server by
hand — Claude Code launches it (stdio) at the start of each session.

## 4. First run

1. Open Packet Tracer first, with the MCP Control Center window open
   (step 2). Packet Tracer must stay open while you work.
2. Start Claude Code in any folder.
3. Ask it: **"cek pt_bridge_status"** (or "check pt_bridge_status").
   `CONNECTED` means the chain Claude Code → server → extension →
   Packet Tracer is live.
4. Then just describe the topology, e.g. "build 3 routers in a line,
   one LAN each, DHCP and OSPF" — or use `pt_full_build`.

There is no token to copy or pair: the server generates the bridge token
once and stores it in `%LOCALAPPDATA%\packet-tracer-mcp\bridge_token`;
the extension reads the same file by itself.

Working files (exports, screenshots, saved plans) go to
`C:\Users\<you>\PacketTracerMCP` by default (`PT_MCP_WORKDIR`).

## 5. Updating

```bat
cd packet-tracer-mcp-node
git pull
npm install
```

## Troubleshooting

- **`pt_bridge_status` not connected** — Packet Tracer is not open, the
  extension is not installed (re-check step 2, including the restart and
  the **Yes** click), or the MCP Control Center window has never been
  opened. Open the window once; afterwards the script engine keeps the
  file-bridge channel alive even with the window closed.
- **Server error in Claude Code** — run it manually once to see the
  error: `node src\index.js --stdio` from the repo folder. The most
  common cause is Node.js < 20.
- **`npm install` fails** — confirm `node -v` prints v20 or newer and
  rerun. No compiler/native build is needed; the only dependency is the
  MCP SDK.
- **Port 54321 busy** — another copy of the server (e.g. the Python
  original) is already running. Close it; one bridge at a time.
- **Extension not detected after restart** — the `.pts` must sit in its
  own subfolder (`extensions\MCPControlCenter\`), not directly in
  `extensions\`, and Packet Tracer must be fully closed before copying
  if it was running.
