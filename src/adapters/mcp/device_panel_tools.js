// Device-panel tools: CLI, Command Prompt, IP Configuration, modules and GUI.
//
// Everything a user would do inside a device's window in PT, through the Script
// Engine API, WITHOUT taking control of the screen. Headless by default; in "ui"
// mode (pt_ui_mode) or with show=True the device's window is also opened on the
// matching tab/app so it can be watched and captured (pt_ui_capture or
// capture=True).
//
// Registered from `register_tools` with the bridge helpers injected, so none of
// this depends on tool_registry.js's closure and it is testable with a fake
// `send_and_wait`. The Desktop apps and Server-PT services live in
// desktop_service_tools.js.

import { IPv6Address } from "../../shared/ipnet.js";
import { monotonic, pyRepr, pyStr, pyTruthy, sleep } from "../../shared/pycompat.js";
import { split_commands } from "../../domain/rules/console_rules.js";
import {
    normalize_mask, parse_ipv6_interface, validate_host_ip_config,
} from "../../domain/rules/panel_rules.js";
import {
    host_ip_config_js, port_state_js, read_device_panel_js,
} from "../../infrastructure/generator/host_js.js";
import { module_change_js, power_cycle_notes } from "../../infrastructure/generator/module_js.js";
import { Presenter, PresenterError, is_available } from "../../infrastructure/ui/presenter.js";
import { UI, UiModeStore } from "../../shared/ui_mode.js";
import { register_desktop_service_tools } from "./desktop_service_tools.js";
import {
    PanelSupport, console_tool_run, errors_text, screenshot_path, with_notes, _strftime,
} from "./panel_support.js";
import { reply_json } from "../../shared/utils.js";

export { screenshot_path };

const _NO_IP = [null, "", "0.0.0.0"];


export function stale_dhcp_ip(before) {
    /** The address a DHCP request must see replaced before calling it a lease.
     *
     * Right after `dhcpRun` the port still shows its previous address. If that
     * was a static one, seeing it again is not a lease. If the port was already
     * a DHCP client, its address is a lease (a renewal may keep it).
     */
    before = before || {};
    const ip = before["ip"] !== undefined ? before["ip"] : null;
    if (_NO_IP.includes(ip) || pyTruthy(before["dhcp"])) {
        return null;
    }
    return ip;
}


export function is_new_lease(state, stale) {
    const ip = (state || {})["ip"] !== undefined && (state || {})["ip"] !== null ? (state || {})["ip"] : null;
    return !_NO_IP.includes(ip) && ip !== stale;
}


export function has_ipv6_address(state, address) {
    /** Whether getIpv6Addresses() (as read by the port reader) lists `address`.
     *
     * PT reports it uppercased ("2001:DB8:0:1::22"), so compare as addresses.
     */
    const want = new IPv6Address(address);
    for (const entry of ((state || {})["ipv6_addresses"] || [])) {
        try {
            if (new IPv6Address(String((entry || {})["address"] !== undefined && (entry || {})["address"] !== null ? (entry || {})["address"] : "")).eq(want)) {
                return true;
            }
        } catch (e) {
            continue;
        }
    }
    return false;
}


export async function register_device_panel_tools(registry, send_and_wait, check_bridge, store = null, presenter = null) {
    store = store || new UiModeStore();
    presenter = presenter || new Presenter(send_and_wait);
    const ps = new PanelSupport(send_and_wait, check_bridge, store, presenter);

    // Wrap the registry so the desktop-service tools (which expect the same
    // registry.tool(name, handler) surface) can register on it too — the Python
    // passes the FastMCP app; here both register through `registry.tool`.
    const mcp = registry;

    // ------------------------------------------------------------------
    // mode
    // ------------------------------------------------------------------
    registry.tool("pt_ui_mode", async (args) => {
        const mode = args.mode !== undefined ? args.mode : "status";
        if (["", "status", "get"].includes((mode || "").trim().toLowerCase())) {
            const cur = await store.get();
            const [ok, why] = await is_available();
            const gui = ok ? "available" : `NOT available (${why})`;
            return (
                `Current mode: ${cur}. PT GUI: ${gui}.\n`
                + "Change it: pt_ui_mode('ui') to show the device windows, "
                + "pt_ui_mode('headless') to work through the API only. Per call: show=True/False."
            );
        }
        let new_mode;
        try {
            new_mode = await store.set(mode);
        } catch (exc) {
            return exc && exc.message !== undefined ? exc.message : pyStr(exc);
        }
        if (new_mode === UI) {
            const [ok, why] = await is_available();
            const extra = ok ? "" : `\nNote: the GUI is not available (${why}); the tools will stay headless.`;
            return ("UI mode on: the panel tools will open the device's window on the matching "
                    + "tab/app. Use capture=True or pt_ui_capture to save PNGs." + extra);
        }
        return "Headless mode on: everything through the API, no windows opened.";
    });

    // ------------------------------------------------------------------
    // consoles
    // ------------------------------------------------------------------
    registry.tool("pt_cli", async (args) => {
        const device = args.device;
        const commands = args.commands;
        const timeout = args.timeout !== undefined ? args.timeout : 30.0;
        const auto_confirm = args.auto_confirm !== undefined ? args.auto_confirm : true;
        const show = args.show !== undefined ? args.show : null;
        const capture = args.capture !== undefined ? args.capture : false;
        const output_dir = args.output_dir !== undefined ? args.output_dir : "screenshots";
        return console_tool_run(ps, device, split_commands(commands), {timeout: timeout,
                                auto_confirm: auto_confirm, show: show, capture: capture,
                                output_dir: output_dir, prefer_host: false});
    });

    registry.tool("pt_host_command", async (args) => {
        const device = args.device;
        const command = args.command;
        const inputs = args.inputs !== undefined ? args.inputs : null;
        const timeout = args.timeout !== undefined ? args.timeout : 30.0;
        const show = args.show !== undefined ? args.show : null;
        const capture = args.capture !== undefined ? args.capture : false;
        const output_dir = args.output_dir !== undefined ? args.output_dir : "screenshots";
        const cmds = [command, ...(inputs || []).map((x) => String(x))];
        return console_tool_run(ps, device, cmds, {timeout: timeout, auto_confirm: true, show: show,
                                capture: capture, output_dir: output_dir, prefer_host: true});
    });

    // ------------------------------------------------------------------
    // explicit GUI
    // ------------------------------------------------------------------
    registry.tool("pt_ui_open", async (args) => {
        const device = args.device;
        const tab = args.tab !== undefined ? args.tab : "";
        const app = args.app !== undefined ? args.app : "";
        const section = args.section !== undefined ? args.section : "";
        const scroll_to_end = args.scroll_to_end !== undefined ? args.scroll_to_end : true;
        const err = await check_bridge();
        if (err) {
            return err;
        }
        const [notes, hwnd] = await ps.present(device, {tab: tab, app: app, section: section, scroll: scroll_to_end});
        return (hwnd ? "Done. " : "") + notes.join("\n");
    });

    registry.tool("pt_ui_close", async (args) => {
        const device = args.device !== undefined ? args.device : "";
        const err = await check_bridge();
        if (err) {
            return err;
        }
        try {
            return await presenter.close(device.trim());
        } catch (exc) {
            if (exc instanceof PresenterError) {
                return exc.message;
            }
            throw exc;
        }
    });

    registry.tool("pt_ui_capture", async (args) => {
        const device = args.device !== undefined ? args.device : "";
        const filename = args.filename !== undefined ? args.filename : "";
        const output_dir = args.output_dir !== undefined ? args.output_dir : "screenshots";
        const err = await check_bridge();
        if (err) {
            return err;
        }
        const name = filename.trim() || `${device || 'packet-tracer'}-${_strftime()}`;
        let info;
        try {
            info = await presenter.capture(device.trim(), screenshot_path(name, output_dir));
        } catch (exc) {
            return `Could not capture: ${exc && exc.message !== undefined ? exc.message : exc}`;
        }
        info["summary"] = `Capture saved to ${info['path']} (${info['width']}x${info['height']}).`;
        if (info["blank"]) {
            info["summary"] += " Note: it came out a single colour; retry with the window visible.";
        }
        return reply_json(info);
    });

    // ------------------------------------------------------------------
    // IP Configuration / panel
    // ------------------------------------------------------------------
    registry.tool("pt_host_ip_config", async (args) => {
        const device = args.device;
        const mode = args.mode !== undefined ? args.mode : "";
        const ip = args.ip !== undefined ? args.ip : "";
        const mask = args.mask !== undefined ? args.mask : "";
        const gateway = args.gateway !== undefined ? args.gateway : "";
        const dns = args.dns !== undefined ? args.dns : "";
        const interface_ = args.interface !== undefined ? args.interface : "";
        const ipv6_mode = args.ipv6_mode !== undefined ? args.ipv6_mode : "";
        const ipv6_gateway = args.ipv6_gateway !== undefined ? args.ipv6_gateway : "";
        const ipv6_dns = args.ipv6_dns !== undefined ? args.ipv6_dns : "";
        const ipv6_address = args.ipv6_address !== undefined ? args.ipv6_address : "";
        const wait_dhcp_s = args.wait_dhcp_s !== undefined ? args.wait_dhcp_s : 12.0;
        const show = args.show !== undefined ? args.show : null;
        const capture = args.capture !== undefined ? args.capture : false;
        const output_dir = args.output_dir !== undefined ? args.output_dir : "screenshots";
        const res = validate_host_ip_config(
            device, {mode: mode, ip: ip, mask: mask, gateway: gateway, dns: dns,
            ipv6_mode: ipv6_mode, ipv6_gateway: ipv6_gateway, ipv6_dns: ipv6_dns,
            ipv6_address: ipv6_address, wait_dhcp_s: wait_dhcp_s},
        );
        if (!res.is_valid) {
            return errors_text(res);
        }
        const err = await check_bridge();
        if (err) {
            return err;
        }
        const v6 = ipv6_address ? parse_ipv6_interface(ipv6_address) : null;
        const js = host_ip_config_js(
            device, interface_.trim(), {mode: mode, ip: ip.trim(),
            mask: ip ? (normalize_mask(mask) || "") : "",
            gateway: gateway.trim() || null, dns: dns.trim() || null,
            ipv6_mode: ipv6_mode, ipv6_gateway: ipv6_gateway.trim(), ipv6_dns: ipv6_dns.trim(),
            ipv6_address: v6 ? v6[0] : "", ipv6_prefix: v6 ? v6[1] : 0},
        );
        let [data, error] = await ps.call(js, device);
        if (error) {
            return error;
        }
        let notes = [];
        let state = data["state"] || {};
        let gw_now = data["gateway"] !== undefined ? data["gateway"] : null;
        let lease = null;
        if (mode === "dhcp" && wait_dhcp_s > 0) {
            const stale = stale_dhcp_ip(data["before"] !== undefined ? data["before"] : null);
            const deadline = monotonic() + wait_dhcp_s;
            while (!is_new_lease(state, stale) && monotonic() < deadline) {
                await sleep(1.0 * 1000);
                const [again, _] = await ps.call(port_state_js(device, data["port"]), device, 8.0);
                if (again) {
                    state = again["state"] || state;
                    gw_now = "gateway" in again ? again["gateway"] : gw_now;
                }
            }
            lease = is_new_lease(state, stale);
            if (!lease && stale && state["ip"] === stale) {
                notes.push(
                    `DHCP: no new lease after ${wait_dhcp_s.toFixed(0)}s. The host still shows its `
                    + `previous static address ${stale}, which is not a DHCP lease. Is a DHCP `
                    + "server reachable (a router with ip dhcp pool, or a Server with "
                    + "pt_server_dhcp)? If that server hands out this same address, confirm "
                    + `with pt_host_command('${device}', 'ipconfig /all').`
                );
            } else if (!lease) {
                notes.push(
                    `DHCP: no lease after ${wait_dhcp_s.toFixed(0)}s. Is a DHCP server reachable `
                    + "(a router with ip dhcp pool, or a Server with pt_server_dhcp)?"
                );
            }
        }
        // After applying, and re-opening the app: IP Configuration reads its
        // values when opened and does not refresh if the API changes them.
        notes = (await ps.show_after(device, show, capture, output_dir, "ipconfig",
                              {tab: "Desktop", app: "ip_configuration"})).concat(notes);
        const out = {
            "device": device,
            "port": data["port"] !== undefined ? data["port"] : null,
            "applied": data["applied"] !== undefined && data["applied"] !== null ? data["applied"] : [],
            "dhcp": state["dhcp"] !== undefined ? state["dhcp"] : null,
            "ip": state["ip"] !== undefined ? state["ip"] : null,
            "mask": state["mask"] !== undefined ? state["mask"] : null,
            "ipv6": state["ipv6"] !== undefined ? state["ipv6"] : null,
            "link_local": state["link_local"] !== undefined ? state["link_local"] : null,
            "ipv6_addresses": state["ipv6_addresses"] !== undefined ? state["ipv6_addresses"] : null,
            "gateway": gw_now,
            "summary": `${device}/${data['port'] !== undefined && data['port'] !== null ? data['port'] : "None"}: ${(data["applied"] || []).join(", ")} → `
                       + `${pyStr(state["ip"] !== undefined && state["ip"] !== null ? state["ip"] : null)}/${pyStr(state["mask"] !== undefined && state["mask"] !== null ? state["mask"] : null)}`
                       + (lease === false ? " (DHCP requested, no lease yet)"
                          : state["dhcp"] ? " (DHCP)" : ""),
            "verify": `pt_host_command('${device}', 'ipconfig /all') shows the DNS too.`,
        };
        // The gateway is read back from HostIpProcess (measured on PT 9).
        const want_gw = gateway.trim();
        if (want_gw && mode !== "dhcp" && gw_now !== null && gw_now !== undefined && gw_now !== want_gw) {
            notes.push(`Gateway: asked for ${want_gw} but the host reads ${gw_now}.`);
        }
        if (lease !== null) {
            out["lease"] = lease;
        }
        if (v6) {
            out["ipv6_static"] = has_ipv6_address(state, v6[0]);
            if (!out["ipv6_static"]) {
                notes.push(
                    `IPv6: ${v6[0]}/${v6[1]} is not among the port's addresses after `
                    + `addIpv6Address (it answered ${pyRepr(data["ipv6_added"] !== undefined ? data["ipv6_added"] : null)}).`
                );
            }
        }
        return with_notes(out, notes);
    });

    registry.tool("pt_read_device_panel", async (args) => {
        const device = args.device;
        const err = await check_bridge();
        if (err) {
            return err;
        }
        const [data, error] = await ps.call(read_device_panel_js(device), device, 12.0);
        if (error) {
            return error;
        }
        delete data["ok"];
        return reply_json(data);
    });

    // ------------------------------------------------------------------
    // Physical
    // ------------------------------------------------------------------
    registry.tool("pt_remove_module", async (args) => {
        const device = args.device;
        const slot = args.slot;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const slot_s = String(slot).trim();
        if (!slot_s) {
            return "Error: empty slot.";
        }
        const js = module_change_js("remove", [{"device": device, "slot": slot_s}]);
        if (dry_run) {
            return reply_json({"js_payload": js, "sent": false, "dry_run": true});
        }
        const err = await check_bridge();
        if (err) {
            return err;
        }
        const [data, error] = await ps.call(js, device, 15.0);
        if (error) {
            return error;
        }
        const result = (data["results"] || [{}])[0] || {};
        const dev = (data["devices"] || [{}])[0] || {};
        const notes = power_cycle_notes(data["devices"] !== undefined && data["devices"] !== null ? data["devices"] : []).map((n) => `\n${n}`).join("");
        if (result["error"] === "device_not_found") {
            return `Device '${device}' not found.`;
        }
        if (result["error"] === "unsupported") {
            return `'${device}' does not support removing modules.`;
        }
        if (!result["ok"]) {
            return `PT removed nothing from slot '${slot_s}' of ${device} (empty, or no such slot?).` + notes;
        }
        const before_set = new Set((dev["ports_before"] !== undefined && dev["ports_before"] !== null ? dev["ports_before"] : "").split(","));
        const after_set = new Set((dev["ports_after"] !== undefined && dev["ports_after"] !== null ? dev["ports_after"] : "").split(","));
        const gone = [...before_set].filter((x) => !after_set.has(x)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        return (`Module removed from ${device} slot ${slot_s}. Ports that disappeared: `
                + `${gone.join(", ") || '(none)'}.` + notes);
    });

    await register_desktop_service_tools(mcp, ps);
}
