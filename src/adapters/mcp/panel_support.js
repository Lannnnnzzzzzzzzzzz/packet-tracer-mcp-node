// Shared plumbing for the panel tools: call PT, show the GUI, capture.

import fs from "node:fs";
import { validate_console_commands } from "../../domain/rules/console_rules.js";
import { format_run, run_commands } from "../../infrastructure/execution/console_session.js";
import { PresenterError } from "../../infrastructure/ui/presenter.js";
import { pyStr, pyTruthy, sleep } from "../../shared/pycompat.js";
import { resolve_within, safe_name_component, workdir_subdir } from "../../shared/utils.js";
import { reply_json } from "../../shared/utils.js";

// Errors returned by the host_js/service_js JS → text for the model.
const _JS_ERRORS = {
    "device_not_found": "'{device}' does not exist in the active topology (pt_query_topology).",
    "port_not_found": "Interface not found on '{device}'. Ports: {ports}",
    "not_host_port": "'{device}' is not a host (PC/Laptop/Server) or that interface is not a host port.",
    "no_HttpClient": "'{device}' has no Web Browser (is it a host?).",
    "no_EmailClient": "'{device}' has no Email client (is it a host?).",
    "no_WirelessClient": "'{device}' has no wireless client: it needs a wireless NIC "
                         + "(e.g. pt_add_module with PT-LAPTOP-NM-1W or WMP300N).",
    "no_DhcpServerMain": "'{device}' has no DHCP service (use a Server-PT).",
    "no_DnsServer": "'{device}' has no DNS service (use a Server-PT).",
    "no_HttpServer": "'{device}' has no HTTP service (use a Server-PT).",
    "no_TftpServer": "'{device}' has no TFTP service.",
    "no_FtpServer": "'{device}' has no FTP service.",
    "no_SyslogServer": "'{device}' has no SYSLOG service.",
    "no_EmailServer": "'{device}' has no EMAIL service.",
    "no_WirelessServerProcess": "'{device}' is not a wireless access point (it has no "
                                + "WirelessServerProcess).",
    "no_rs232": "'{device}' has no RS 232 port (Terminal only exists on hosts).",
};


export function parse_panel_reply(raw, device) {
    /** A host_js/service_js-style JSON reply: [data, null] or [null, error message]. */
    if (raw === null || raw === undefined) {
        return [null, "No answer from PT (timeout)."];
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return [null, `Unexpected reply from PT: ${raw.slice(0, 300)}`];
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
        return [null, `Unexpected reply from PT: ${raw.slice(0, 300)}`];
    }
    if (!pyTruthy("ok" in data ? data["ok"] : true)) {
        const err = pyStr(data["error"] !== undefined && data["error"] !== null ? data["error"] : "error");
        const tmpl = _JS_ERRORS[err];
        if (tmpl) {
            const ports = "ports" in data ? data["ports"] : "?";
            return [null, tmpl.replaceAll("{device}", device).replaceAll("{ports}", pyStr(ports))];
        }
        const detail = data["detail"];
        return [null, `PT answered: ${err}` + (pyTruthy(detail) ? ` (${detail})` : "")];
    }
    return [data, null];
}


export function errors_text(result) {
    return "Validation failed:\n" + result.errors.map((e) => `  - ${e}`).join("\n");
}


export function screenshot_path(filename, output_dir = "screenshots") {
    /** Safe path for a capture (same scheme as pt_screenshot). */
    const base = workdir_subdir(output_dir, "screenshots");
    fs.mkdirSync(base, { recursive: true });
    return resolve_within(base, safe_name_component(filename, "capture") + ".png");
}


export class PanelSupport {
    constructor(send_and_wait, check_bridge, store, presenter) {
        this.send = send_and_wait;
        this.check_bridge = check_bridge;
        this.store = store;
        this.presenter = presenter;
    }

    // -- PT ---------------------------------------------------------------
    async call(js, device, timeout = 10.0) {
        /** Run JS that reports JSON. [data, null] or [null, error message]. */
        return parse_panel_reply(await this.send(js, timeout), device);
    }

    // -- GUI --------------------------------------------------------------
    async visible(show, capture = false) {
        return (await this.store.should_show(show)) || Boolean(capture);
    }

    async present(device, { tab = "", app = "", section = "", scroll = false, reopen = false } = {}) {
        try {
            if (reopen && section) {
                // Services/Config pages read their values when shown: going to
                // another tab and back forces them to re-read.
                await this.presenter.open(device, { tab: "Physical" });
            }
            var r = await this.presenter.open(device, { tab: tab, app: app, section: section,
                                    scroll_bottom: scroll, reopen: reopen });
        } catch (exc) {
            if (exc instanceof PresenterError) {
                return [[`GUI: could not show it (${exc.message}). The work was still done through the API.`], null];
            }
            // UIA/COM can fail in many ways
            const name = (exc && exc.name) || (exc && exc.constructor && exc.constructor.name) || "Error";
            const msg = exc && exc.message !== undefined ? exc.message : pyStr(exc);
            return [[`GUI: unexpected error while showing it (${name}: ${msg}).`], null];
        }
        return [["GUI: " + r["steps"].join(" → ")], r["hwnd"]];
    }

    async capture(device, label, output_dir) {
        const name = `${device}-${label}-${_strftime_now()}`;
        let info;
        try {
            info = await this.presenter.capture(device, screenshot_path(name, output_dir));
        } catch (exc) {
            if (exc instanceof PresenterError || exc instanceof Error) {
                const msg = exc && exc.message !== undefined ? exc.message : pyStr(exc);
                return [`Capture failed: ${msg}`];
            }
            throw exc;
        }
        const warn = info["blank"] ? "  (it came out blank!)" : "";
        return [`Capture: ${info['path']} (${info['width']}x${info['height']})${warn}`];
    }

    async show_after(device, show, capture, output_dir, label, where = {}) {
        /** For state panels: show AFTER applying (and re-read), capture if asked. */
        if (!(await this.visible(show, capture))) {
            return [];
        }
        let [notes, hwnd] = await this.present(device, { ...where, reopen: true });
        if (hwnd && capture) {
            await sleep(0.4 * 1000);
            notes = notes.concat(await this.capture(device, label, output_dir));
        }
        return notes;
    }
}

function _strftime_now() {
    // time.strftime('%Y%m%d-%H%M%S') in local time.
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
export { _strftime_now as _strftime };



export function with_notes(payload, notes) {
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
        if (pyTruthy(notes)) {
            payload["notes"] = notes;
        }
        return reply_json(payload);
    }
    return payload + (pyTruthy(notes) ? "\n\n" + notes.join("\n") : "");
}


export async function console_tool_run(ps, device, cmds, { timeout, auto_confirm, show, capture, output_dir, prefer_host, gui_device = "", gui_app = "" } = {}) {
    /** What pt_cli / pt_host_command / pt_terminal have in common.
     *
     * `gui_device`/`gui_app` show a DIFFERENT window from the device being typed
     * on (pt_terminal: typing goes to the router, the PC's Terminal is shown).
     */
    const res = validate_console_commands(device, cmds, timeout);
    if (!res.is_valid) {
        return errors_text(res);
    }
    const err = await ps.check_bridge();
    if (err) {
        return err;
    }
    let notes = [];
    let hwnd = null;
    const shown = gui_device || device;
    if (await ps.visible(show, capture)) {
        // Consoles update live: open them BEFORE, so the typing can be watched.
        let tab, app;
        if (gui_app) {
            tab = "Desktop"; app = gui_app;
        } else {
            let host;
            try {
                host = Boolean((await ps.presenter.device_info(device))["host"]);
            } catch (e) {
                host = prefer_host;
            }
            [tab, app] = host ? ["Desktop", "command_prompt"] : ["CLI", ""];
        }
        [notes, hwnd] = await ps.present(shown, { tab: tab, app: app, scroll: true });
    }
    const run = await run_commands(ps.send, device, cmds, { timeout: timeout, auto_confirm: auto_confirm });
    if (hwnd) {
        try {
            await ps.presenter.scroll_consoles(hwnd);
        } catch (e) {
            // pass
        }
        if (capture) {
            await sleep(0.3 * 1000);
            notes = notes.concat(await ps.capture(shown, gui_app || (run.host ? "cmd" : "cli"), output_dir));
        }
    }
    const label = run.host ? "Command Prompt" : "CLI";
    return with_notes(format_run(run, label), notes);
}
