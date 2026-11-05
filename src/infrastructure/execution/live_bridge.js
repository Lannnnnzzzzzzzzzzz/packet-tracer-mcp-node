// HTTP Command Bridge for Packet Tracer. (Port of infrastructure/execution/live_bridge.py)
//
// Allows the MCP server to send JavaScript commands to PT via the MCP Control Center
// extension. Works by running a local HTTP server that the PT webview polls for
// commands.
//
// SECURITY: every endpoint except /ping requires the shared token from
// bridge_token.js. Binding to 127.0.0.1 is NOT a security control here — a POST
// with Content-Type text/plain is a CORS-simple request, so any web page open in
// any browser on this host could reach /queue, and PT executes whatever it finds
// there via new Function(). The token is what closes that; see bridge_token.js.
//
// The extension gets the token by reading the token file through PT's Script
// Engine (ipc.systemFileManager), so there is nothing to pair and no window in
// which the secret is served over HTTP.
//
// Commands are queued over HTTP and results come back keyed by `rid`: each
// operation generates its own, it travels inside the injected JS, and PT returns
// it when posting. Without that correlation — when results were one global FIFO
// queue — a late result was left orphaned and was consumed by the NEXT operation,
// which received real PT data but from a different device. The file channel
// already correlated by name; this is the same pattern over HTTP.
//
// Usage:
//     1. Start the bridge: const bridge = new PTCommandBridge(); await bridge.start()
//     2. Open the MCP Control Center in PT — it authenticates on its own
//     3. The MCP adapter enqueues via POST /queue and collects via GET /result?rid=…
//
// PORT NOTE (the one sanctioned improvement): the bind address comes from the
// PT_MCP_BRIDGE_HOST environment variable, defaulting to "127.0.0.1" exactly
// like upstream. When set, "<host>:<port>" is added to the Host allowlist.

import crypto from "node:crypto";
import http from "node:http";
import { get_bridge_token, token_fingerprint } from "./bridge_token.js";
import { pyJsonDumps, pyRound } from "../../shared/pycompat.js";

export const DEFAULT_PORT = 54321;

// 1 MiB. Real commands are a few KB; this only curbs abuse.
export const MAX_BODY_BYTES = 1 << 20;

// Bounded queue: if PT hangs, the queue cannot grow without limit.
export const MAX_QUEUE_ITEMS = 1000;

// Upper bound on the /result wait. The caller sets the timeout — it knows how
// long its operation takes — but it cannot ask for just anything: each wait
// occupies a connection. Real callers ask for up to 45 s.
export const MAX_RESULT_WAIT_SECONDS = 60.0;

// A result nobody collects is discarded after this long. Without a purge, the
// results table would trade the correlation bug for a memory leak.
export const RESULT_TTL_SECONDS = 60.0;

// Hard cap on the table, in case more orphaned results arrive than the TTL covers.
export const MAX_RESULT_ITEMS = 256;

// /next waits up to this long for a command to appear instead of replying empty
// right away. It lowers latency (the command goes out as soon as it is queued,
// not on the next 500 ms tick) and eliminates the trickle of empty requests.
export const NEXT_LONGPOLL_SECONDS = 2.0;

// Maximum number of commands /next returns in one response. PT runs them in a
// single runCode. Measured against PT 9.0: 10 devices + links + IOS config in
// ~100 ms when run back to back, with no need to space them out.
export const MAX_BATCH_COMMANDS = 200;

let _rid_counter = 0;

export function next_rid() {
    /** Operation id, unique per process.
     *
     * Same scheme as `FileBridge._next_name`: the pid separates MCP processes that
     * share the bridge and the counter separates operations within one process.
     * It contains no characters that need escaping, because it goes in a query string.
     */
    _rid_counter += 1;
    return `${process.pid}-${_rid_counter}`;
}

export function report_result_js(port = DEFAULT_PORT, token = "", rid = "") {
    /** JS that defines reportResult() to send results back to the bridge.
     *
     * It is defined inline with each command so it shares the runCode scope.
     * It routes the result through the webview's XMLHttpRequest, because PT's
     * Script Engine has no XMLHttpRequest of its own.
     *
     * The `rid` identifies the operation and travels in here, so PT returns it
     * on its own: the extension never builds this URL, it only runs the JS it
     * receives.
     *
     * The token goes BEFORE the rid on purpose — there is a test that expects to find
     * the literal `/result?t=<token>`.
     */
    const q = "'";   // '
    const dq = '"';  // "
    const bs = "\\"; // backslash
    return (
        "function reportResult(d){"
        + "var s=String(d)"
        + `.replace(/${bs}${bs}/g,${q}${bs}${bs}${bs}${bs}${q})`
        + `.replace(/${q}/g,${dq}${bs}${bs}${q}${dq})`
        + `.replace(/${bs}n/g,${q}${bs}${bs}n${q});`
        + "window.webview.evaluateJavaScriptAsync("
        + `${q}var x=new XMLHttpRequest();`
        + `x.open(${bs}${q}POST${bs}${q},${bs}${q}http://127.0.0.1:${port}/result?t=${token}&rid=${rid}${bs}${q},true);`
        + `x.setRequestHeader(${bs}${q}Content-Type${bs}${q},${bs}${q}text/plain${bs}${q});`
        + `x.send(${bs}${q}${q}+s+${q}${bs}${q});${q}`
        + ")}"
    );
}

function _timingSafeEqualStr(a, b) {
    const ba = Buffer.from(a, "utf-8");
    const bb = Buffer.from(b, "utf-8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

export class PTCommandBridge {
    /** HTTP bridge between the MCP server and Packet Tracer's webview extension. */

    constructor(port = DEFAULT_PORT, token = null) {
        this.port = port;
        this.token = token || get_bridge_token();
        this.token_id = token_fingerprint(this.token);
        this._queue = [];             // string[], bounded FIFO
        this._queue_waiters = [];     // resolve functions waiting for a command
        // {rid: [result, timestamp]}. A Map and not a queue: with a queue, a late
        // result that nobody collected stayed at the front and was taken by the
        // next operation.
        this._results = new Map();
        this._result_waiters = new Map(); // rid -> Set of resolve functions
        this._result_ttl = RESULT_TTL_SECONDS;
        this._server = null;
        this._connected = false;
        this._last_poll_time = 0.0;
        // Diagnostics: tell "PT is not running" apart from "PT is running but we rejected it".
        this._unauth_count = 0;
        this._unauth_last = 0.0;
        this._unauth_paths = new Set();
        // What PT actually sends on its first authenticated poll. It is the only
        // way to know which Origin the webview uses without guessing.
        this._client_headers = {};
        // Sanctioned config: PT_MCP_BRIDGE_HOST sets the bind address and is
        // added to the Host allowlist. Unset → identical to upstream.
        this.bind_host = process.env.PT_MCP_BRIDGE_HOST || "127.0.0.1";
    }

    // -- state ---------------------------------------------------------

    get is_connected() {
        if (this._last_poll_time === 0) {
            return false;
        }
        return Date.now() / 1000 - this._last_poll_time < 10.0;
    }

    get saw_recent_unauthorized() {
        /** True if something tried to talk without a token recently.
         *
         * This is what separates 'PT is not open' from 'PT is open but its extension
         * is outdated and we are rejecting it' — two situations that looked identical.
         */
        return this._unauth_last > 0 && (Date.now() / 1000 - this._unauth_last) < 30.0;
    }

    status_dict() {
        const ago = Date.now() / 1000 - this._last_poll_time;
        return {
            "connected": this._last_poll_time > 0 && ago < 10.0,
            "last_poll_ago": this._last_poll_time ? pyRound(ago, 1) : null,
            "unauth_recent": this.saw_recent_unauthorized,
            "unauth_count": this._unauth_count,
            "unauth_paths": [...this._unauth_paths].sort(),
            "client_headers": { ...this._client_headers },
            "token_id": this.token_id,
        };
    }

    // -- correlated results -------------------------------------

    _purge_results() {
        /** Discard results that nobody collected. */
        const now = Date.now() / 1000;
        for (const [rid, [, ts]] of this._results) {
            if (now - ts > this._result_ttl) {
                this._results.delete(rid);
            }
        }
        // Hard cap in case more orphans arrive than the TTL can clean up: the
        // oldest ones go first.
        if (this._results.size >= MAX_RESULT_ITEMS) {
            const oldest = [...this._results.entries()].sort((a, b) => a[1][1] - b[1][1]);
            for (const [rid] of oldest.slice(0, this._results.size - MAX_RESULT_ITEMS + 1)) {
                this._results.delete(rid);
            }
        }
    }

    put_result(rid, body) {
        /** Store the result for `rid` and wake whoever is waiting for it. */
        this._purge_results();
        this._results.set(rid, [body, Date.now() / 1000]);
        const waiters = this._result_waiters.get(rid);
        if (waiters) {
            this._result_waiters.delete(rid);
            for (const resolve of waiters) resolve();
        }
    }

    async take_result(rid, wait) {
        /** Wait for and consume the result for `rid`. null if it did not arrive in time.
         *
         * Without `rid` in the picture this returned the first result there
         * was — from whichever operation that was.
         */
        const deadline = Date.now() / 1000 + Math.min(Math.max(wait, 0.0), MAX_RESULT_WAIT_SECONDS);
        while (true) {
            const hit = this._results.get(rid);
            if (hit !== undefined) {
                this._results.delete(rid);
                return hit[0];
            }
            const remaining = deadline - Date.now() / 1000;
            if (remaining <= 0) {
                return null;
            }
            await new Promise((resolve) => {
                let set = this._result_waiters.get(rid);
                if (!set) { set = new Set(); this._result_waiters.set(rid, set); }
                const timer = setTimeout(() => { set.delete(wrapper); resolve(); }, remaining * 1000);
                const wrapper = () => { clearTimeout(timer); resolve(); };
                set.add(wrapper);
            });
        }
    }

    _enqueue(body) {
        if (this._queue.length >= MAX_QUEUE_ITEMS) return false;
        this._queue.push(body);
        const waiters = this._queue_waiters.splice(0);
        for (const resolve of waiters) resolve();
        return true;
    }

    async drain_commands() {
        /** Wait for the first command and take every command already queued.
         *
         * Delivering them one at a time every 500 ms made a 40-command topology take
         * tens of seconds. PT runs the whole batch in a single runCode, and each
         * command already carries its own try/catch.
         */
        const cmds = [];
        if (this._queue.length === 0) {
            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    const i = this._queue_waiters.indexOf(wrapper);
                    if (i >= 0) this._queue_waiters.splice(i, 1);
                    resolve();
                }, NEXT_LONGPOLL_SECONDS * 1000);
                const wrapper = () => { clearTimeout(timer); resolve(); };
                this._queue_waiters.push(wrapper);
            });
        }
        while (cmds.length < MAX_BATCH_COMMANDS && this._queue.length > 0) {
            cmds.push(this._queue.shift());
        }
        return cmds;
    }

    // -- server -------------------------------------------------------

    _host_ok(req) {
        /** The Host is derived by the client from the URL it requested.
         *
         * PT always sends 127.0.0.1:<port>. A request that arrives through DNS
         * rebinding comes with Host: evil.com:<port>, so this check cuts it off
         * and it cannot break PT.
         */
        const host = (req.headers["host"] || "").trim().toLowerCase();
        const allowed = [
            `127.0.0.1:${this.port}`,
            `localhost:${this.port}`,
            `[::1]:${this.port}`,
        ];
        if (process.env.PT_MCP_BRIDGE_HOST) {
            allowed.push(`${this.bind_host.toLowerCase()}:${this.port}`);
        }
        return allowed.includes(host);
    }

    _token_from(req, qs) {
        return qs.get("t") || req.headers["x-pt-token"] || "";
    }

    _authorized(req, qs) {
        if (!this._host_ok(req)) {
            return false;
        }
        return _timingSafeEqualStr(this._token_from(req, qs), this.token);
    }

    _note_unauth(path) {
        this._unauth_count += 1;
        this._unauth_last = Date.now() / 1000;
        this._unauth_paths.add(path);
    }

    _remember_client(req) {
        if (Object.keys(this._client_headers).length > 0) {
            return;
        }
        for (const h of ["Origin", "Sec-Fetch-Site", "Sec-Fetch-Mode", "User-Agent"]) {
            const v = req.headers[h.toLowerCase()];
            if (v) {
                this._client_headers[h] = v;
            }
        }
    }

    _cors_headers(res) {
        // Kept permissive on OK responses: PT's webview depends on CORS to read
        // them, and we do not know yet which Origin it sends (it is recorded in
        // _remember_client so it can be tightened later).
        // CORS never prevented the request from being SENT — that was the bug,
        // and what closes it is the token, not this header.
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PT-Token");
    }

    _respond(res, code, body) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        this._cors_headers(res);
        res.writeHead(code);
        res.end(body, "utf-8");
    }

    async _deny(req, res, code = 401, path = "") {
        if (code === 401 && path) {
            this._note_unauth(path);
        }
        // Drain a small body before responding: if we close while the client
        // is still writing, it sees a reset instead of the error code
        // (WinError 10053 on Windows). Large bodies are NOT read on purpose —
        // that is the point of the 413.
        if (!req.readableEnded) {
            let length = 0;
            try { length = parseInt(req.headers["content-length"] || "0", 10) || 0; } catch (e) { length = 0; }
            if (length > 0 && length <= 65536) {
                await new Promise((resolve) => {
                    req.resume();
                    req.on("data", () => {});
                    req.on("end", resolve);
                    req.on("error", resolve);
                    setTimeout(resolve, 2000);
                });
            } else {
                req.resume();
            }
        }
        res.shouldKeepAlive = false;
        res.writeHead(code, {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": "0",
            "Connection": "close",
        });
        // No CORS headers: nothing legitimate reads an error, and this way a
        // hostile web page cannot even tell why it failed.
        res.end();
    }

    /** Reads the body up to the cap. Returns null if it must be rejected (deny already sent). */
    async _read_body(req, res) {
        let length;
        try {
            const raw = req.headers["content-length"];
            length = raw === undefined ? 0 : parseInt(raw, 10);
            if (Number.isNaN(length)) throw new Error("bad length");
        } catch (e) {
            await this._deny(req, res, 400);
            return null;
        }
        if (length < 0 || length > MAX_BODY_BYTES) {
            await this._deny(req, res, 413);
            return null;
        }
        if (!length) {
            return "";
        }
        const chunks = [];
        let got = 0;
        for await (const chunk of req) {
            chunks.push(chunk);
            got += chunk.length;
            if (got > length) break;
        }
        return Buffer.concat(chunks).subarray(0, length).toString("utf-8");
        // NOTE: Python decodes with errors="replace"; Buffer.toString replaces
        // invalid sequences with U+FFFD as well.
    }

    async _handle(req, res) {
        const parsed = new URL(req.url, "http://127.0.0.1");
        const path = parsed.pathname;
        const qs = parsed.searchParams;
        const bridge = this;

        if (req.method === "OPTIONS") {
            res.writeHead(200);
            this._cors_headers(res);
            res.end();
            return;
        }

        if (req.method === "GET") {
            if (path === "/ping") {
                // Unauthenticated on purpose: it is needed to detect who occupies
                // the port BEFORE knowing whether it is our bridge. It only returns
                // a non-reversible fingerprint of the token.
                this._respond(res, 200, pyJsonDumps({
                    "service": "pt-mcp-bridge",
                    "proto": 1,
                    "id": bridge.token_id,
                }));
                return;
            }

            if (!this._authorized(req, qs)) {
                await this._deny(req, res, 401, path);
                return;
            }

            if (path === "/next") {
                this._remember_client(req);
                // Mark the connection BEFORE the long-poll: otherwise, while waiting
                // in the queue, the bridge would think it is disconnected.
                bridge._connected = true;
                bridge._last_poll_time = Date.now() / 1000;
                const cmds = await bridge.drain_commands();
                this._respond(res, 200, cmds.join("\n"));
            } else if (path === "/status") {
                this._respond(res, 200, pyJsonDumps(bridge.status_dict()));
            } else if (path === "/result") {
                // The caller sets the wait: it knows how long its operation takes.
                const rid = (qs.get("rid") || "").trim();
                if (!rid) {
                    this._respond(res, 204, "");
                    return;
                }
                let wait = parseFloat(qs.get("wait") || "9");
                if (Number.isNaN(wait)) wait = 9.0;
                const result = await bridge.take_result(rid, wait);
                if (result === null) {
                    this._respond(res, 204, "");
                } else {
                    this._respond(res, 200, result);
                }
            } else {
                await this._deny(req, res, 404);
            }
            return;
        }

        if (req.method === "POST") {
            if (!this._authorized(req, qs)) {
                await this._deny(req, res, 401, path);
                return;
            }

            const body = await this._read_body(req, res);
            if (body === null) {
                return;
            }

            if (path === "/result") {
                // A result without a rid cannot be attributed to any operation. It
                // is discarded: storing it "just in case" is exactly how it used to
                // contaminate the next one.
                const rid = (qs.get("rid") || "").trim();
                if (!rid) {
                    this._respond(res, 200, "discarded");
                    return;
                }
                bridge.put_result(rid, body);
                this._respond(res, 200, "ok");
            } else if (path === "/queue") {
                if (body) {
                    if (!bridge._enqueue(body)) {
                        await this._deny(req, res, 503);
                        return;
                    }
                }
                this._respond(res, 200, "queued");
            } else {
                await this._deny(req, res, 404);
            }
            return;
        }

        await this._deny(req, res, 404);
    }

    start() {
        /** Start the HTTP command server. Resolves once listening. */
        return new Promise((resolve, reject) => {
            this._server = http.createServer((req, res) => {
                this._handle(req, res).catch(() => {
                    try { res.destroy(); } catch (e) { /* already gone */ }
                });
            });
            this._server.once("error", reject);
            this._server.listen(this.port, this.bind_host, () => {
                // port=0 asks for an ephemeral port; the real one must be recovered so that
                // the Host validation and the bootstrap point at the right place.
                this.port = this._server.address().port;
                resolve();
            });
        });
    }

    stop() {
        /** Stop the HTTP server. */
        if (this._server) {
            const server = this._server;
            this._server = null;
            return new Promise((resolve) => {
                server.close(() => resolve());
                if (typeof server.closeAllConnections === "function") {
                    server.closeAllConnections();
                }
            });
        }
        return Promise.resolve();
    }

    // There is no `send`/`send_and_wait` here on purpose: the MCP adapter talks to
    // the bridge over HTTP (POST /queue, GET /result), not by calling methods on
    // this instance — the bridge may have been started by another process.
}
