// Tools for the Desktop apps and the Server-PT services.
//
// Web Browser, Email, Firewall, Terminal; Services > DHCP, DNS, HTTP, TFTP, FTP,
// SYSLOG, EMAIL. Same as the rest of the panel: the work goes through the Script
// Engine API and, if showing it was asked for, the matching page of the device's
// window is shown afterwards (re-read, because those pages don't refresh on
// their own).

import { monotonic, pyStr, pyTruthy, sleep } from "../../shared/pycompat.js";
import { split_commands, validate_console_commands } from "../../domain/rules/console_rules.js";
import {
    MAX_BROWSER_TIMEOUT_S, normalize_mask, validate_wait_seconds,
} from "../../domain/rules/panel_rules.js";
import {
    EMAIL_ACTIONS, SERVICES, parse_range, validate_dhcp, validate_dns, validate_email_server,
    validate_texts, validate_users,
} from "../../domain/rules/service_rules.js";
import {
    console_peer_js, email_client_js, host_firewall_js, server_dhcp_js, server_dns_js, server_http_js, server_service_js,
    web_go_js, web_read_js,
} from "../../infrastructure/generator/service_js.js";
import { console_tool_run, errors_text, with_notes } from "./panel_support.js";

const _TEXT_CAP = 6000;


export function html_to_text(page) {
    /** Readable text of a page: what the person would see in the Web Browser. */
    let t = (page || "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
    t = t.replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr|title)>/gi, "\n");
    t = t.replace(/<[^>]+>/g, "");
    t = _html_unescape(t);
    const lines = t.split("\n").map((ln) => ln.trim());
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function _html_unescape(t) {
    // html.unescape: named and numeric entities.
    const named = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " "};
    return t.replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (m, body) => {
        if (body.startsWith("#x") || body.startsWith("#X")) {
            const cp = parseInt(body.slice(2), 16);
            return Number.isNaN(cp) ? m : String.fromCodePoint(cp);
        }
        if (body.startsWith("#")) {
            const cp = parseInt(body.slice(1), 10);
            return Number.isNaN(cp) ? m : String.fromCodePoint(cp);
        }
        return body in named ? named[body] : m;
    });
}


const _NO_SETTER = {"tftp": "TFTP", "wlc": "WLC"};


export function dhcp_pool_problems(pool, requested, pools, skipped) {
    /** Requested pool fields that PT did not end up holding, read back from PT.
     *
     * `requested` maps read-back keys (gateway, dns, start, mask, max_users,
     * tftp, wlc) to what was asked; empty/0 means "leave alone" and is not
     * checked. `skipped` are fields the JS could not set on an existing pool
     * (PT has no TFTP/WLC setter). Nothing requested → nothing to report.
     */
    const wanted = {};
    for (const [k, v] of Object.entries(requested)) if (pyTruthy(v)) wanted[k] = v;
    if (!Object.keys(wanted).length) {
        return [];
    }
    const got = pools.find((p) => p["name"] === pool) || null;
    if (got === null) {
        return [`pool '${pool}' is not on the server after the change`];
    }
    const problems = [];
    for (const [key, value] of Object.entries(wanted)) {
        const got_val = got[key] !== undefined && got[key] !== null ? got[key] : null;
        if (skipped.includes(key)) {
            problems.push(`${key}: PT has no setter for an existing pool's ${_NO_SETTER[key] !== undefined ? _NO_SETTER[key] : key} `
                            + `address, so it was not applied (still ${pyStr(got_val)}); delete and `
                            + "recreate the pool to set it");
        } else if (pyStr(got_val) !== pyStr(value)) {
            problems.push(`${key}: requested ${pyStr(value)}, PT has ${pyStr(got_val)}`);
        }
    }
    return problems;
}


export function http_page_problems(device, failed) {
    /** One line per page PT refused, from server_http_js's `failed`.
     *
     * PT 9.0.0 answers a page that is not on the server with "File not exist:
     * <page>": no API in use creates pages, so say so instead of echoing PT.
     */
    const problems = [];
    for (const f of failed) {
        const page = String(f["page"] !== undefined && f["page"] !== null ? f["page"] : "?"), err = String(f["error"] !== undefined && f["error"] !== null ? f["error"] : "");
        if (err.toLowerCase().includes("not exist")) {
            problems.push(`page '${page}' does not exist on ${device}: pt_server_http can only `
                            + "replace pages that already exist there (a Server-PT has index.html), "
                            + `not create new ones. Put the content in an existing page. (PT: ${err})`);
        } else {
            problems.push(`page '${page}' was not written: PT answered: ${err}`);
        }
    }
    return problems;
}


export function http_both_off_warning(device) {
    /** Why server_http_js refused a call (its `blocked`): HTTP and HTTPS were both off.
     *
     * Live on PT 9.0.0.810, a call that turned them back on and wrote a page
     * from that state hung the script engine and PT crashed.
     */
    return (`Nothing was changed on ${device}: HTTP and HTTPS are both off, and Packet `
            + "Tracer 9.0.0 hangs and then crashes when a single call turns either back on "
            + "or writes pages from that state. Turn HTTP or HTTPS on once by hand in "
            + `${device}'s Services > HTTP tab (or leave one of them on), then retry. Calls `
            + "that only turn things off are still allowed.");
}


export function email_account_names(raw) {
    /** Usernames out of PT's getAllEmailAcctAsStrings() ("user:password,..."), passwords dropped. */
    return (raw || "").split(",").filter((a) => a.trim()).map((a) => a.split(":")[0].trim());
}


export function syslog_messages(raw) {
    /** SYSLOG entries as PT serialized them: parsed when JSON, the text otherwise.
     *
     * getAllEntries()'s element fields were never measured, so nothing is renamed
     * or dropped here; a JSON entry becomes its object, anything else stays a string.
     */
    const out = [];
    for (const item of (Array.isArray(raw) ? raw : [])) {
        if (typeof item === "string") {
            try {
                out.push(JSON.parse(item));
                continue;
            } catch (e) {
                // pass
            }
        }
        out.push(item);
    }
    return out;
}


export function email_not_applied(data, { domain = "", smtp = null, pop3 = null } = {}) {
    /** EMAIL settings that did not read back as requested (empty when all stuck). */
    const want = {"domain": domain || null, "smtp": smtp, "pop3": pop3};
    return Object.entries(want).filter(([k, v]) => v !== null && v !== undefined && data[k] !== v).map(([k]) => k);
}


export async function register_desktop_service_tools(registry, ps) {
    // Last URL each host's browser loaded through pt_web_browser (this server
    // process only): tells "same URL again" apart from a failed navigation.
    const last_url = {};

    // ------------------------------------------------------------------
    // Web Browser
    // ------------------------------------------------------------------
    registry.tool("pt_web_browser", async (args) => {
        const device = args.device;
        const url = args.url;
        const timeout = args.timeout !== undefined ? args.timeout : 10.0;
        const show = args.show !== undefined ? args.show : null;
        const capture = args.capture !== undefined ? args.capture : false;
        const output_dir = args.output_dir !== undefined ? args.output_dir : "screenshots";
        const v = validate_texts(device, {url: url});
        v.errors.push(...validate_wait_seconds(device, "timeout", timeout,
                                              MAX_BROWSER_TIMEOUT_S).errors);
        if (!v.is_valid) {
            return errors_text(v);
        }
        const err = await ps.check_bridge();
        if (err) {
            return err;
        }
        let target = url.trim();
        if (!/^[a-z]+:\/\//i.test(target)) {
            target = "http://" + target;
        }
        let notes = [];
        const [before, error0] = await ps.call(web_read_js(device), device);
        if (error0) {
            return error0;
        }
        const previous = before["content"] !== undefined && before["content"] !== null ? before["content"] : "";
        let hwnd = null;
        let navigated_by_gui = false;
        if (await ps.visible(show, capture)) {
            [notes, hwnd] = await ps.present(device, {tab: "Desktop", app: "web_browser"});
            if (hwnd) {
                try {
                    navigated_by_gui = await ps.presenter.fill_and_go(hwnd, "m_urlEdit", target, "m_goButton");
                } catch (exc) {
                    notes.push(`GUI: couldn't type the URL (${exc && exc.message !== undefined ? exc.message : exc}); navigating through the API.`);
                }
            }
        }
        if (!navigated_by_gui) {
            const [started, error1] = await ps.call(web_go_js(device, target), device);
            if (error1) {
                return error1;
            }
            if (!started["started"]) {
                return `${device}'s browser rejected the URL '${target}'.`;
            }
        }
        // PT only exposes the last page received, not the URL it came from:
        // an unchanged page proves nothing unless this same URL is what the
        // browser last loaded through this tool.
        const same_url = last_url[device] === target;
        let content = previous;
        const deadline = monotonic() + timeout;
        let stable_since = null;
        while (monotonic() < deadline) {
            await sleep(0.5 * 1000);
            const [data, _] = await ps.call(web_read_js(device), device);
            if (!data) {
                continue;
            }
            content = data["content"] !== undefined && data["content"] !== null ? data["content"] : "";
            if (content && content !== previous) {
                break;
            }
            // Same URL as last time: wait a little in case it changes, then
            // keep what is there. A different URL waits for new content.
            stable_since = stable_since || monotonic();
            if (same_url && content && monotonic() - stable_since > 3.0) {
                break;
            }
        }
        if (hwnd && capture) {
            await sleep(0.6 * 1000);
            notes = notes.concat(await ps.capture(device, "browser", output_dir));
        }
        if (!content) {
            return with_notes(
                `${device} → ${target}: no answer within ${timeout.toFixed(0)}s `
                + "(right IP/DNS? HTTP on at the server? is there a route?).", notes);
        }
        if (content === previous) {
            if (!same_url) {
                return with_notes({
                    "device": device, "url": target, "ok": false,
                    "warning": (
                        `${device}'s browser still shows the page it had before: ${target} `
                        + `gave no new page within ${timeout.toFixed(0)}s (right IP/DNS? HTTP on at the `
                        + "server? is there a route? still loading?), or it serves byte-for-byte "
                        + "that same page. The old page is not returned as this URL's content."
                    ),
                }, notes);
            }
            notes.push("The page is identical to the last one loaded in this browser.");
        }
        last_url[device] = target;
        const text = html_to_text(content);
        const cut = text.length > _TEXT_CAP;
        const out = {
            "device": device, "url": target, "html_bytes": content.length,
            "text": text.slice(0, _TEXT_CAP) + (cut ? "\n…(cut)" : ""),
        };
        if (/Request Timeout|Host Name Unresolved|Server Reset Connection/i.test(text)) {
            out["warning"] = "PT's browser showed an error page.";
        }
        return with_notes(out, notes);
    });

    // ------------------------------------------------------------------
    // Services
    // ------------------------------------------------------------------
    registry.tool("pt_server_dhcp", async (args) => {
        const device = args.device;
        const pool = args.pool !== undefined ? args.pool : "serverPool";
        const gateway = args.gateway !== undefined ? args.gateway : "";
        const dns = args.dns !== undefined ? args.dns : "";
        const start_ip = args.start_ip !== undefined ? args.start_ip : "";
        const mask = args.mask !== undefined ? args.mask : "";
        const max_users = args.max_users !== undefined ? args.max_users : 0;
        const tftp = args.tftp !== undefined ? args.tftp : "";
        const wlc = args.wlc !== undefined ? args.wlc : "";
        const enable = args.enable !== undefined ? args.enable : true;
        const remove_pool = args.remove_pool !== undefined ? args.remove_pool : "";
        const exclude = args.exclude !== undefined ? args.exclude : null;
        const interface_ = args.interface !== undefined ? args.interface : "";
        const show = args.show !== undefined ? args.show : null;
        const capture = args.capture !== undefined ? args.capture : false;
        const output_dir = args.output_dir !== undefined ? args.output_dir : "screenshots";
        const ex = [...(exclude || [])];
        const norm_mask = mask ? (normalize_mask(mask) || "") : "";
        const v = validate_dhcp(device, {pool: pool, gateway: gateway, dns: dns, start_ip: start_ip,
                          mask: mask, max_users: Math.trunc(Number(max_users || 0)), tftp: tftp, wlc: wlc, exclude: ex,
                          remove_pool: remove_pool});
        if (!v.is_valid) {
            return errors_text(v);
        }
        const err = await ps.check_bridge();
        if (err) {
            return err;
        }
        const js = server_dhcp_js(
            device, {port: interface_.trim(), pool: pool.trim(), gateway: gateway, dns: dns,
            start_ip: start_ip, mask: norm_mask,
            max_users: Math.trunc(Number(max_users || 0)), tftp: tftp, wlc: wlc, enable: enable,
            remove_pool: remove_pool.trim(), exclude: ex.map((r) => parse_range(r))},
        );
        const [data, error] = await ps.call(js, device);
        if (error) {
            return error;
        }
        const requested = {"gateway": gateway, "dns": dns, "start": start_ip, "mask": norm_mask,
                     "max_users": Math.trunc(Number(max_users || 0)), "tftp": tftp, "wlc": wlc};
        const problems = dhcp_pool_problems(pool.trim(), requested, data["pools"] || [],
                                      data["not_applied"] || []);
        data["ok"] = !problems.length;
        delete data["not_applied"];
        if (problems.length) {
            data["not_applied"] = problems;
            data["warning"] = (`Pool '${pool.trim()}': ${problems.length} requested field(s) `
                               + "are not what PT now holds; see not_applied.");
        }
        const notes = await ps.show_after(device, show, capture, output_dir, "dhcp",
                              {tab: "Services", section: "DHCP"});
        return with_notes(data, notes);
    });

    registry.tool("pt_server_dns", async (args) => {
        const device = args.device;
        const records = args.records !== undefined ? args.records : null;
        const remove = args.remove !== undefined ? args.remove : null;
        const enable = args.enable !== undefined ? args.enable : true;
        const show = args.show !== undefined ? args.show : null;
        const capture = args.capture !== undefined ? args.capture : false;
        const output_dir = args.output_dir !== undefined ? args.output_dir : "screenshots";
        const recs = (records || []).map((r) => ({...r}));
        const rem = (remove || []).map((r) => ({...r}));
        for (const r of recs.concat(rem)) {
            r["type"] = String(r["type"] !== undefined && r["type"] !== null ? r["type"] : "A").toUpperCase();
        }
        const v = validate_dns(device, recs, rem);
        if (!v.is_valid) {
            return errors_text(v);
        }
        const err = await ps.check_bridge();
        if (err) {
            return err;
        }
        const [data, error] = await ps.call(server_dns_js(device, {records: recs, remove: rem, enable: enable}), device);
        if (error) {
            return error;
        }
        delete data["ok"];
        const notes = await ps.show_after(device, show, capture, output_dir, "dns", {tab: "Services", section: "DNS"});
        return with_notes(data, notes);
    });

    registry.tool("pt_server_http", async (args) => {
        const device = args.device;
        const pages = args.pages !== undefined ? args.pages : null;
        const enable = args.enable !== undefined ? args.enable : true;
        const https_enable = args.https_enable !== undefined ? args.https_enable : null;
        const show = args.show !== undefined ? args.show : null;
        const capture = args.capture !== undefined ? args.capture : false;
        const output_dir = args.output_dir !== undefined ? args.output_dir : "screenshots";
        const pg = {};
        for (const [k, val] of Object.entries(pages || {})) pg[String(k)] = String(val);
        const fields = {};
        for (const k of Object.keys(pg)) fields[`page ${k}`] = k;
        const v = validate_texts(device, fields);
        if (!v.is_valid) {
            return errors_text(v);
        }
        const err = await ps.check_bridge();
        if (err) {
            return err;
        }
        const [data, error] = await ps.call(server_http_js(device, {pages: pg, enable: enable,
                                             https_enable: https_enable}), device);
        if (error) {
            return error;
        }
        const blocked = data["blocked"] !== undefined && data["blocked"] !== null ? data["blocked"] : [];
        delete data["blocked"];
        if (pyTruthy(blocked)) {
            // The JS found HTTP and HTTPS both off and sent nothing to PT.
            delete data["failed"];
            data["ok"] = false;
            data["not_applied"] = blocked.map((b) => String(b));
            data["warning"] = http_both_off_warning(device);
            const notes = await ps.show_after(device, show, capture, output_dir, "http",
                                  {tab: "Services", section: "HTTP"});
            return with_notes(data, notes);
        }
        const failed = data["failed"] !== undefined && data["failed"] !== null ? data["failed"] : [];
        delete data["failed"];
        const problems = http_page_problems(device, failed);
        data["ok"] = !problems.length;
        if (problems.length) {
            data["not_applied"] = problems;
            data["warning"] = (`${problems.length} page(s) not written (`
                               + failed.map((f) => String(f["page"] !== undefined && f["page"] !== null ? f["page"] : "?")).join(", ")
                               + "); see not_applied.");
        }
        const notes = await ps.show_after(device, show, capture, output_dir, "http", {tab: "Services", section: "HTTP"});
        return with_notes(data, notes);
    });

    registry.tool("pt_server_service", async (args) => {
        const device = args.device;
        const service = args.service;
        let enable = args.enable !== undefined ? args.enable : null;
        const users = args.users !== undefined ? args.users : null;
        const domain = args.domain !== undefined ? args.domain : "";
        let smtp = args.smtp !== undefined ? args.smtp : null;
        let pop3 = args.pop3 !== undefined ? args.pop3 : null;
        const show = args.show !== undefined ? args.show : null;
        const capture = args.capture !== undefined ? args.capture : false;
        const output_dir = args.output_dir !== undefined ? args.output_dir : "screenshots";
        const svc = (service || "").trim().toLowerCase();
        const us = (users || []).map((u) => ({...u}));
        const dom = (domain || "").trim();
        const v = validate_users(device, svc, us);
        v.errors.push(...validate_email_server(device, svc, {domain: dom, smtp: smtp, pop3: pop3}).errors);
        if (!v.is_valid) {
            return errors_text(v);
        }
        const err = await ps.check_bridge();
        if (err) {
            return err;
        }
        if (svc === "email" && enable !== null) {
            smtp = smtp === null ? enable : smtp;
            pop3 = pop3 === null ? enable : pop3;
        }
        const [data, error] = await ps.call(server_service_js(
            device, svc, {enable: enable, users: us, domain: dom || null, smtp: smtp, pop3: pop3}), device);
        if (error) {
            return error;
        }
        delete data["ok"];
        if (svc === "email") {
            const missed = email_not_applied(data, {domain: dom, smtp: smtp, pop3: pop3});
            if (missed.length) {
                data["not_applied"] = missed;
            }
        }
        // PT hands back "user:password" pairs; credentials never leave the device.
        if ("accounts" in data) {
            data["accounts"] = email_account_names(String(data["accounts"]));
        }
        if ("messages" in data) {
            data["messages"] = syslog_messages(data["messages"]);
        }
        const notes = await ps.show_after(device, show, capture, output_dir, svc,
                              {tab: "Services", section: svc.toUpperCase()});
        return with_notes(data, notes);
    });

    // ------------------------------------------------------------------
    // Email client
    // ------------------------------------------------------------------
    registry.tool("pt_email_client", async (args) => {
        const device = args.device;
        const action = args.action !== undefined ? args.action : "configure";
        const name = args.name !== undefined ? args.name : "";
        const address = args.address !== undefined ? args.address : "";
        const username = args.username !== undefined ? args.username : "";
        const password = args.password !== undefined ? args.password : "";
        const smtp_server = args.smtp_server !== undefined ? args.smtp_server : "";
        const pop3_server = args.pop3_server !== undefined ? args.pop3_server : "";
        const to = args.to !== undefined ? args.to : "";
        const subject = args.subject !== undefined ? args.subject : "";
        const body = args.body !== undefined ? args.body : "";
        const show = args.show !== undefined ? args.show : null;
        const capture = args.capture !== undefined ? args.capture : false;
        const output_dir = args.output_dir !== undefined ? args.output_dir : "screenshots";
        const act = (action || "").trim().toLowerCase();
        if (!EMAIL_ACTIONS.includes(act)) {
            return `Invalid action: '${action}'. Use: ${EMAIL_ACTIONS.join(", ")}.`;
        }
        const v = validate_texts(device, {name: name, address: address, username: username,
                           password: password, smtp_server: smtp_server, pop3_server: pop3_server,
                           to: to, subject: subject, body: body});
        if (!v.is_valid) {
            return errors_text(v);
        }
        if (act === "send" && !to) {
            return "To send, 'to' is missing.";
        }
        const err = await ps.check_bridge();
        if (err) {
            return err;
        }
        const [data, error] = await ps.call(email_client_js(
            device, {action: act, name: name, address: address, username: username,
            password: password, smtp_server: smtp_server, pop3_server: pop3_server,
            to: to, subject: subject, body: body}), device);
        if (error) {
            return error;
        }
        delete data["ok"];
        const notes = await ps.show_after(device, show, capture, output_dir, "email", {tab: "Desktop", app: "email"});
        return with_notes(data, notes);
    });

    // ------------------------------------------------------------------
    // Firewall, Terminal
    // ------------------------------------------------------------------
    registry.tool("pt_host_firewall", async (args) => {
        const device = args.device;
        const ipv4 = args.ipv4 !== undefined ? args.ipv4 : null;
        const ipv6 = args.ipv6 !== undefined ? args.ipv6 : null;
        const interface_ = args.interface !== undefined ? args.interface : "";
        const show = args.show !== undefined ? args.show : null;
        const capture = args.capture !== undefined ? args.capture : false;
        const output_dir = args.output_dir !== undefined ? args.output_dir : "screenshots";
        if (ipv4 === null && ipv6 === null) {
            return "Pass ipv4=True/False and/or ipv6=True/False.";
        }
        const err = await ps.check_bridge();
        if (err) {
            return err;
        }
        const [data, error] = await ps.call(host_firewall_js(device, {port: interface_.trim(), ipv4: ipv4, ipv6: ipv6}), device);
        if (error) {
            return error;
        }
        delete data["ok"];
        const app = ipv4 === null ? "ipv6_firewall" : "firewall";
        const notes = await ps.show_after(device, show, capture, output_dir, app, {tab: "Desktop", app: app});
        return with_notes(data, notes);
    });

    registry.tool("pt_terminal", async (args) => {
        const device = args.device;
        const commands = args.commands;
        const timeout = args.timeout !== undefined ? args.timeout : 30.0;
        const auto_confirm = args.auto_confirm !== undefined ? args.auto_confirm : true;
        const show = args.show !== undefined ? args.show : null;
        const capture = args.capture !== undefined ? args.capture : false;
        const output_dir = args.output_dir !== undefined ? args.output_dir : "screenshots";
        // Validate first: rejected input must neither query PT nor open a window.
        const cmds = split_commands(commands);
        const res = validate_console_commands(device, cmds, timeout);
        if (!res.is_valid) {
            return errors_text(res);
        }
        const err = await ps.check_bridge();
        if (err) {
            return err;
        }
        const [data, error] = await ps.call(console_peer_js(device), device);
        if (error) {
            return error;
        }
        const peer = data["peer"] !== undefined ? data["peer"] : null;
        if (!peer) {
            return (`${device} has no console cable on '${pyStr(data['rs232'] !== undefined && data['rs232'] !== null ? data['rs232'] : null)}'. Connect it with `
                    + `pt_add_link('${device}', 'RS 232', '<router>', 'Console', cable_type='console').`);
        }
        let prefix = `${device}'s Terminal → console of ${peer} (${pyStr(data['peer_port'] !== undefined && data['peer_port'] !== null ? data['peer_port'] : null)})\n`;
        if (await ps.visible(show, capture)) {
            const [notes, hwnd] = await ps.present(device, {tab: "Desktop", app: "terminal"});
            if (hwnd) {
                try {
                    await ps.presenter.invoke_button(hwnd, "OK");  // "Terminal Configuration" 9600 8N1
                } catch (e) {
                    // pass
                }
            }
            prefix += notes.length ? (notes.join("\n") + "\n") : "";
        }
        let out = await console_tool_run(ps, peer, cmds, {timeout: timeout,
                               auto_confirm: auto_confirm, show: false, capture: false,
                               output_dir: output_dir, prefer_host: false});
        if (capture) {
            await sleep(0.4 * 1000);
            out += "\n" + (await ps.capture(device, "terminal", output_dir)).join("\n");
        }
        return prefix + out;
    });
}
