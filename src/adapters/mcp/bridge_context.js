// Bridge plumbing shared by every live tool: channel pick, send, send-and-wait.
// (Port of adapters/mcp/bridge_context.py)
//
// Two channels coexist: HTTP (the MCP Control Center window is open) and file
// (window closed, Script Engine alive). ONE is picked per command, never both.

import { get_bridge_token, token_fingerprint } from "../../infrastructure/execution/bridge_token.js";
import { FileBridge } from "../../infrastructure/execution/file_bridge.js";
import {
    DEFAULT_PORT, PTCommandBridge, next_rid, report_result_js,
} from "../../infrastructure/execution/live_bridge.js";
import { FAST_FORWARD_JS, parse_fast_forward } from "../../infrastructure/generator/simulation_js.js";
import { WALK_JS } from "../../infrastructure/generator/walk_js.js";
import { sleep, monotonic } from "../../shared/pycompat.js";

// Commands per POST. Bounded so large topologies stay well below the bridge's
// body limit, and so progress is visible in PT.
export const DEPLOY_BATCH = 50;

// One single timeout message, instead of four nearly identical variants.
export const TIMEOUT_MSG = (
    "No response from PT (timeout). Check pt_bridge_status — PT must be open "
    + "with the MCP Control Center extension."
);

// JS that reads the active topology and returns it as structured JSON.
// JSON.stringify is available in PT's Script Engine (verified live).
// isPortUp()/getLink() feed the health check and the diff. Each port is stored
// with its name as is (including subinterfaces "Gig0/0.10" if any).
export const LIVE_DEVICES_JS = (
    WALK_JS +
    "var net=ipc.network();var arr=[];"
    + "__eachDevice(function(d){var ports=[];"
    + "__eachPort(d,function(p){var ip='';var mask='';var up=false;var linked=false;"
    + "try{ip=p.getIpAddress()||'';}catch(pe){}"
    + "try{mask=p.getSubnetMask()||'';}catch(pe){}"
    + "try{up=(typeof p.isPortUp==='function')?p.isPortUp():false;}catch(pe){}"
    + "try{linked=(p.getLink()!=null);}catch(pe){}"
    + "ports.push({name:p.getName(),ip:ip,mask:mask,up:up,linked:linked});"
    + "});"
    + "arr.push({name:d.getName(),model:d.getModel(),ports:ports});"
    + "});"
    + "reportResult(JSON.stringify({devices:arr,links:net.getLinkCount()}));"
);

// After starting the bridge, how long to wait for the extension to find it. It polls
// /status every 2 s, so a first call answered "not connected" while PT was a moment away.
export const BRIDGE_GRACE_S = 5.0;
export const BRIDGE_GRACE_POLL_S = 0.25;

// New switch ports spend ~30 s in STP listening/learning (15 s + 15 s) before they
// forward, so a ping right after cabling is lost. settle_stp skips that
// window with Fast Forward Time and only sleeps out what is left of it when that fails.
export const STP_SETTLE_S = 32.0;
const _LINK_CALLS = ["addLink(", "lwAddLink(", "createLink("];

export function creates_links(js) {
    return _LINK_CALLS.some((call) => js.includes(call));
}

export function stp_wait_seconds(last_link_change, now, settle = STP_SETTLE_S) {
    /** Seconds still to wait before a ping can cross links created at `last_link_change`. */
    if (last_link_change === null || last_link_change === undefined) {
        return 0.0;
    }
    return Math.max(0.0, settle - (now - last_link_change));
}

export class BridgeContext {
    /** One per MCP server: owns the in-process HTTP bridge and the file channel. */

    constructor(port = DEFAULT_PORT, file_bridge = null) {
        this.port = port;
        this.url = `http://127.0.0.1:${port}`;
        this.file_bridge = file_bridge !== null && file_bridge !== undefined ? file_bridge : new FileBridge();
        this.instance = null;
        // monotonic() of the last JS that created a link (see STP_SETTLE_S).
        this.last_link_change = null;
    }

    _note(js) {
        if (creates_links(js)) {
            this.last_link_change = monotonic();
        }
    }

    _signed(url) {
        /** Add the bridge token to the URL.
         *
         * Signed here and not on each call so there is no tokenless path that
         * someone could add by mistake later on.
         */
        const sep = url.includes("?") ? "&" : "?";
        return `${url}${sep}t=${encodeURIComponent(get_bridge_token())}`;
    }

    async http_get(url, timeout = 2.0) {
        // Returns [status, body]; [null, null] on any failure — including HTTP
        // error statuses, which is what urllib raises for in the original.
        try {
            const r = await fetch(this._signed(url), {
                signal: AbortSignal.timeout(timeout * 1000),
            });
            if (r.status >= 400) return [null, null];
            return [r.status, await r.text()];
        } catch (e) {
            return [null, null];
        }
    }

    async http_post(url, body, timeout = 3.0) {
        try {
            const r = await fetch(this._signed(url), {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: body,
                signal: AbortSignal.timeout(timeout * 1000),
            });
            if (r.status >= 400) return [null, null];
            return [r.status, await r.text()];
        } catch (e) {
            return [null, null];
        }
    }

    static js_guard(js) {
        /** Wrap a JS command in a Script-Engine-level try/catch (fire-and-forget).
         *
         * Without this, an UNCAUGHT error inside runCode raises a modal QMessageBox
         * in PT that freezes the webview and kills the bridge's polling — the modal
         * has to be closed by hand to reconnect. The catch is silent because this path
         * expects no answer; the path that does wait (send_and_wait) uses its own
         * catch that reports the error via reportResult() so it doesn't hang until the timeout.
         */
        return "try{" + js + "}catch(__pterr){}";
    }

    js_guard(js) {
        return BridgeContext.js_guard(js);
    }

    async bridge_identity() {
        /** Who is listening on the port: 'ours' | 'foreign' | 'none'.
         *
         * It used to be enough for something to answer 200 on /ping to accept it —
         * and from then on EVERY JS payload was sent to that process, whatever it
         * was. Now /ping returns an identity document with the token's
         * fingerprint, so ours can be told apart from a stranger.
         */
        const [status, body] = await this.http_get(`${this.url}/ping`, 1.0);
        if (status !== 200 || !body) {
            return "none";
        }
        let doc;
        try {
            doc = JSON.parse(body);
        } catch (e) {
            return "foreign";
        }
        if (doc["service"] !== "pt-mcp-bridge") {
            return "foreign";
        }
        if (doc["id"] !== token_fingerprint(get_bridge_token())) {
            return "foreign";
        }
        return "ours";
    }

    async bridge_is_up() {
        return (await this.bridge_identity()) === "ours";
    }

    async bridge_pt_connected() {
        const [status, body] = await this.http_get(`${this.url}/status`, 1.0);
        if (status === 200 && body) {
            try {
                return JSON.parse(body)["connected"] ?? false;
            } catch (e) {
                // fall through
            }
        }
        return false;
    }

    async ensure_bridge(grace = true) {
        /**
         * Ensures a bridge is listening on :54321.
         * If there already is one (internal or external), does nothing.
         * If there is none, starts one in-process and, with
         * `grace`, gives the extension a moment to find it.
         * Returns True if the bridge is operational.
         */
        if (await this.bridge_is_up()) {
            return true;  // there is already an active one on the port
        }
        if (this.instance === null) {
            try {
                const b = new PTCommandBridge();
                await b.start();
                this.instance = b;
            } catch (e) {
                return false;  // port blocked by an external non-bridge process
            }
            if (grace && (await this.bridge_is_up())) {
                const deadline = monotonic() + BRIDGE_GRACE_S;
                while (!(await this.bridge_pt_connected()) && monotonic() < deadline) {
                    await sleep(BRIDGE_GRACE_POLL_S * 1000);
                }
            }
        }
        return this.bridge_is_up();
    }

    async pick_channel() {
        /** 'http' | 'file' | '' depending on which executor is available. */
        if ((await this.bridge_is_up()) && (await this.bridge_pt_connected())) {
            return "http";
        }
        if (this.file_bridge.pt_alive()) {
            return "file";
        }
        return "";
    }

    async channel_send(payload) {
        /** Send fire-and-forget over the available channel. */
        this._note(payload);
        const ch = await this.pick_channel();
        if (ch === "http") {
            const [status] = await this.http_post(`${this.url}/queue`, payload);
            return status === 200;
        }
        if (ch === "file") {
            return this.file_bridge.send(payload);
        }
        return false;
    }

    stale_client_message() {
        /** Message for when PT reaches the bridge but we reject it because of the token.
         *
         * Without this, 'PT is not open' and 'PT is open but its extension is old'
         * looked exactly the same, and the symptom was 'it stopped working' with no cause.
         */
        return (
            "Packet Tracer IS reaching the bridge, but every request is being "
            + "REJECTED (missing or invalid token).\n\n"
            + "Why: this version requires an automatically-generated local token on "
            + "every bridge request. The code running inside Packet Tracer was built "
            + "by an older version and doesn't carry it. Nothing is wrong with your "
            + "setup.\n\n"
            + "Fix: update the MCP Control Center extension to V5.0+ from\n"
            + "https://github.com/Mats2208/MCP-Packet-Tracer/releases/latest\n"
            + "and reopen it. V5 reads the token from disk automatically — nothing "
            + "to pair or paste. The token is stored on this machine and reused "
            + "across restarts."
        );
    }

    async send_and_wait(js_call, timeout = 10.0) {
        /** Send JS and wait for the result, over the available channel.
         *
         * The js_call is wrapped in try/catch: an uncaught error is reported as
         * 'PT_ERROR: ...' via reportResult instead of opening a modal that kills the bridge.
         *
         * HTTP and file differ in how reportResult arrives, so the wrapper is
         * built differently per channel:
         * - HTTP: report_result_js defines a reportResult that does an XHR to /result.
         * - file: the Script Engine injects a local reportResult that captures the
         *   value and writes it to the res file; here the "raw" js is sent with its try/catch.
         */
        this._note(js_call);
        const ch = await this.pick_channel();
        const guarded = (
            "try{" + js_call + "}catch(__pterr){reportResult('PT_ERROR: '+__pterr);}"
        );
        if (ch === "http") {
            // The rid correlates this operation with ITS result. It travels inside
            // the injected JS, so PT returns it by itself and the extension never
            // knows. Without it, a result arriving late was picked up by the
            // next operation.
            const rid = next_rid();
            const wrapped = (
                report_result_js(this.port, get_bridge_token(), rid) + ";" + guarded
            );
            const [status_post] = await this.http_post(`${this.url}/queue`, wrapped);
            if (status_post !== 200) {
                return null;
            }
            // The `wait` goes to the server: whoever asks for the operation knows how
            // long it takes. The socket timeout sits above it so the server's wins
            // and a 204 means "it did not arrive", not "I hung".
            const [status_get, body] = await this.http_get(
                `${this.url}/result?rid=${rid}&wait=${timeout}`,
                timeout + 5.0,
            );
            return status_get === 200 ? body : null;
        }
        if (ch === "file") {
            return this.file_bridge.send_and_wait(guarded, timeout);
        }
        return null;
    }

    async canvas_size() {
        /** [width, height] of PT's visible logical view when a channel is up, else null.
         *
         * Planning uses it to fit the layout to the user's screen; with no channel the
         * layout falls back to its default size.
         */
        if (!(await this.pick_channel())) {
            return null;
        }
        const { read_canvas_size } = await import("../../infrastructure/execution/canvas_view.js");
        const size = await read_canvas_size(async (js, t) => this.send_and_wait(js, t));
        if (size === null) {
            return null;
        }
        return [Math.max(400, size[0]), Math.max(300, size[1])];
    }

    async check_bridge() {
        /** Check that there is a channel to PT (HTTP or file). Error message or null.
         *
         * The script engine helpers (lwAddDevice, etc.) are defined by the extension
         * (installMcpHelpers in V5), so there is nothing to inject per channel.
         */
        let ch = await this.pick_channel();
        if (ch === "http" || ch === "file") {
            return null;
        }
        // No live channel: start HTTP in case the window is about to open, and look
        // again — the extension may have found it during ensure_bridge's grace period.
        await this.ensure_bridge();
        ch = await this.pick_channel();
        if (ch === "http" || ch === "file") {
            return null;
        }
        if (this.instance !== null && this.instance.saw_recent_unauthorized) {
            return this.stale_client_message();
        }
        return (
            "Packet Tracer is not connected over any channel.\n"
            + "Open the MCP Control Center extension in PT (Extensions > MCP BUILDER). "
            + "With the window open it uses HTTP; if you close it, the file channel "
            + "takes over while PT stays open."
        );
    }

    async read_live_devices() {
        /** Read PT's active topology as a structured list of devices.
         *
         * Each element: {name, model, ports:[{name, ip, mask, up, linked}]}.
         * null when the read failed (no answer, PT error, unreadable reply), so a
         * failed read is never mistaken for an empty canvas ([]).
         */
        const result = await this.send_and_wait(LIVE_DEVICES_JS, 10.0);
        if (!result || result.startsWith("PT_ERROR") || result.startsWith("ERROR")) {
            return null;
        }
        let devices;
        try {
            devices = JSON.parse(result)["devices"];
        } catch (e) {
            return null;
        }
        return Array.isArray(devices) ? devices : null;
    }

    async live_devices() {
        /** `read_live_devices`, with a failed read as [] (the best-effort pre-checks:
         * module compat, ACL/NAT, pt_diff). */
        return (await this.read_live_devices()) || [];
    }

    async fast_forward() {
        /** Press Realtime's Fast Forward Time: STP converges at once (measured, PT 9.0).
         *
         * Returns the parsed reply. In Simulation mode nothing is pressed
         * (fast_forwarded=false). Once it worked, links created before it are no
         * longer waiting on STP.
         */
        const data = parse_fast_forward(await this.send_and_wait(FAST_FORWARD_JS, 5.0));
        if (data["fast_forwarded"]) {
            this.last_link_change = null;
        }
        return data;
    }

    async settle_stp() {
        /** Get links created moments ago past STP before a ping or a DHCP request.
         *
         * Fast-forwards PT's clock instead of sleeping; if that is not possible
         * (Simulation mode, an old PT, no answer), sleeps out what is left of the
         * STP_SETTLE_S window as before. Returns the seconds slept (0 when nothing
         * was pending or the fast-forward worked).
         */
        const wait = stp_wait_seconds(this.last_link_change, monotonic());
        if (wait <= 0 || (await this.fast_forward())["fast_forwarded"]) {
            return 0.0;
        }
        await sleep(wait * 1000);
        return wait;
    }

    async send_payload(js_call) {
        /** Send a fire-and-forget JS payload over the available channel (HTTP or file). */
        return this.channel_send(BridgeContext.js_guard(js_call));
    }
}
