// File transport between the MCP server and Packet Tracer's Script Engine.
// (Port of infrastructure/execution/file_bridge.py)
//
// Why it exists, in addition to the HTTP bridge:
// HTTP polling lives in the extension's webview (the window). If the user closes it,
// the webview dies and PT stops running commands — even though the extension
// remains installed. The Script Engine, in contrast, runs WHENEVER PT is open
// (no window), has setInterval and file access, but does NOT have
// XMLHttpRequest. So the channel with the Script Engine cannot be HTTP: it is a
// file mailbox.
//
// Coexistence (not replacement): HTTP remains the channel while the window is
// open; this channel takes over when it is closed. Routing (choosing one
// per request, never both) lives in the adapter; only the transport lives here.
//
// Security: the mailbox lives under %LOCALAPPDATA% with a user ACL, just like the
// token. A web page in the browser cannot write a local file, so this channel does
// not have the CORS vector that forced the HTTP channel to authenticate. The trust
// level is the same one the threat model already assumes: the local user.
//
// Protocol (one file per request, atomic write tmp+rename):
//     server  ─ writes req_<seq>.js  (atomic) ─►  Script Engine
//     server  ◄─ reads/deletes res_<seq>.txt    ─   writes res, deletes req
//     Script Engine touches alive.txt every tick (liveness heartbeat)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { token_dir } from "./bridge_token.js";
import { sleep } from "../../shared/pycompat.js";

// Mailbox subdirectory, under the same dir as the token.
const _BRIDGE_SUBDIR = "bridge";

// The Script Engine is considered alive if it touched alive.txt less than this long ago.
export const HEARTBEAT_FRESH_S = 6.0;

export function bridge_dir() {
    /** Where the Script Engine's mailbox lives.
     *
     * On Windows, next to the token. Elsewhere it has to be where the V5 extension
     * writes it: mcpBridgeDir() takes its FIRST token candidate,
     * <home>/AppData/Local/packet-tracer-mcp, whatever the OS. Matching it here keeps
     * the released .pts working on macOS and Linux without rebuilding it.
     */
    if (process.platform === "win32") {
        return path.join(token_dir(), _BRIDGE_SUBDIR);
    }
    return path.join(os.homedir(), "AppData", "Local", "packet-tracer-mcp", _BRIDGE_SUBDIR);
}

export function ensure_bridge_dir() {
    const d = bridge_dir();
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
}

export class FileBridge {
    /** Server side of the file mailbox.
     *
     * No state of its own beyond a sequence counter; the real state is the
     * files on disk, so it survives process restarts.
     */

    constructor(directory = null) {
        this.dir = directory !== null && directory !== undefined ? String(directory) : bridge_dir();
        this._seq = 0;
    }

    _ensure() {
        // ALWAYS creates this.dir, not the module default: if a custom
        // directory was passed (tests, config), creation and writing must
        // point to the same place.
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }

    // -- Script Engine liveness ----------------------------------------

    pt_alive() {
        /** True if the Script Engine touched its heartbeat recently. */
        const alive = path.join(this.dir, "alive.txt");
        try {
            const age = Date.now() / 1000 - fs.statSync(alive).mtimeMs / 1000;
            return age < HEARTBEAT_FRESH_S;
        } catch (e) {
            return false;
        }
    }

    // -- sending ----------------------------------------------------------

    _next_name() {
        // Monotonic sequence within the process + pid, so concurrent MCP
        // processes sharing the same mailbox do not collide.
        this._seq += 1;
        return `${process.pid}_${String(this._seq).padStart(6, "0")}`;
    }

    _write_atomic(p, text) {
        // tmp + replace: the Script Engine, which lists the directory, never sees a
        // half-written file (replace is atomic within the volume).
        //
        // EXACT bytes: write as UTF-8 bytes, never through anything that could
        // translate \n -> \r\n. A real CR/LF inside a JS string literal is a
        // SyntaxError. The command (e.g. configureIosDevice with \n between
        // CLI lines) must reach the Script Engine exactly as it was generated.
        const tmp = p + ".tmp";
        fs.writeFileSync(tmp, Buffer.from(text, "utf-8"));
        fs.renameSync(tmp, p);
    }

    send(js_code) {
        /** Queues a fire-and-forget command. Does not wait for a result. */
        try {
            this._ensure();
            const name = this._next_name();
            this._write_atomic(path.join(this.dir, `req_${name}.js`), js_code);
            return true;
        } catch (e) {
            return false;
        }
    }

    async send_and_wait(js_code, timeout = 12.0) {
        /** Queues a command and waits for its res_<name>.txt.
         *
         * The Script Engine wraps the execution and writes the result; here the
         * appearance of the response file is polled and then consumed.
         */
        try {
            this._ensure();
        } catch (e) {
            return null;
        }
        const name = this._next_name();
        const res_path = path.join(this.dir, `res_${name}.txt`);
        try {
            this._write_atomic(path.join(this.dir, `req_${name}.js`), js_code);
        } catch (e) {
            return null;
        }

        const deadline = Date.now() / 1000 + timeout;
        while (Date.now() / 1000 < deadline) {
            try {
                if (fs.existsSync(res_path)) {
                    const body = fs.readFileSync(res_path, "utf-8");
                    try { fs.unlinkSync(res_path); } catch (e) { /* missing_ok */ }
                    return body;
                }
            } catch (e) {
                // ignore and keep polling, like the Python original
            }
            await sleep(100);
        }
        // Timeout: we leave the req in case the Script Engine processes it late, but we clean
        // up the res if it appeared between the last check and now.
        try {
            fs.unlinkSync(res_path);
        } catch (e) {
            // missing_ok
        }
        return null;
    }
}
