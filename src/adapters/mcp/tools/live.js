// Live deploy and bridge tools: deploy a plan into PT, full build, bridge status, connectivity, save/open.
// (Port of adapters/mcp/tools/live.py)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TopologyPlan } from "../../../domain/models/plans.js";
import { TopologyRequest } from "../../../domain/models/requests.js";
import { fit_plan_to_canvas, plan_from_request } from "../../../domain/services/orchestrator.js";
import { explain_plan } from "../../../domain/services/explainer.js";
import { estimate_from_plan } from "../../../domain/services/estimator.js";
import { validate_plan } from "../../../domain/services/validator.js";
import {
    generate_full_script,
    generate_executable_script,
} from "../../../infrastructure/generator/ptbuilder_generator.js";
import {
    generate_all_configs,
    generate_pc_config,
    static_host_ips,
} from "../../../infrastructure/generator/cli_config_generator.js";
import { ManualExecutor } from "../../../infrastructure/execution/manual_executor.js";
import { DeployExecutor } from "../../../infrastructure/execution/deploy_executor.js";
import { token_was_rotated, token_is_ephemeral } from "../../../infrastructure/execution/bridge_token.js";
import { BridgeContext, DEPLOY_BATCH } from "../bridge_context.js";
import {
    PING_TIMEOUT_S, device_check_status, ping_no_result_message, reconcile_commands,
    verify_and_reconcile, file_open_js, file_open_outcome, DEVICE_COUNT_JS,
    dhcp_address_report, dhcp_host_ports, dhcp_lease_report, pin_wifi_clients, read_host_ips,
    renew_dhcp_leases,
    save_project_js,
    console_ping_arm_js, console_ping_poll_js,
} from "../../../infrastructure/execution/live_checks.js";
import { WALK_JS } from "../../../infrastructure/generator/walk_js.js";
import { RoutingProtocol, TopologyTemplate, enumByValue } from "../../../shared/enums.js";
import { pyJsonDumps, pyRound, pyStr, pyTruthy, sleep, monotonic } from "../../../shared/pycompat.js";
import {
    safe_name_component, resolve_within, resolve_open_path, resolve_save_dir,
    classify_ping as _classify_ping, name_collisions, read_plan_source,
} from "../../../shared/utils.js";

// Names of the devices on the canvas, as a JSON array.
const _LIVE_NAMES_JS = (
    "try{" + WALK_JS + "var a=[];__eachDevice(function(d){a.push(d.getName());});"
    + "reportResult(JSON.stringify(a));}catch(e){reportResult('[]');}"
);

export function save_target_exists(directory, name) {
    /** Whether `name` already exists under the local `directory` (pt_save_project). */
    try {
        const dir = directory.startsWith("~")
            ? directory.replace(/^~(?=$|\/|\\)/, os.homedir())
            : directory;
        return fs.existsSync(resolve_within(path.resolve(dir), name));
    } catch (e) {
        return false;
    }
}

// Python `RoutingProtocol(value)` / `TopologyTemplate(value)`: the string
// itself when valid, a ValueError with CPython's message when not.
function _routing_protocol(value) {
    const v = enumByValue(RoutingProtocol, value);
    if (v === undefined) {
        throw new Error(`'${value}' is not a valid RoutingProtocol`);
    }
    return v;
}

function _topology_template(value) {
    const v = enumByValue(TopologyTemplate, value);
    if (v === undefined) {
        throw new Error(`'${value}' is not a valid TopologyTemplate`);
    }
    return v;
}

// Python `err.code.value`: in JS the code IS the string (see domain/models/errors.js).
function _code_value(err) {
    const code = err["code"];
    if (code !== null && code !== undefined && typeof code === "object" && "value" in code) {
        return code.value;
    }
    return code;
}

// Python `plan.model_dump_json()`: pydantic's compact JSON (raw UTF-8).
function _plan_dump_json(plan) {
    if (typeof plan.model_dump_json === "function") return plan.model_dump_json();
    if (typeof plan.modelDumpJson === "function") return plan.modelDumpJson();
    if (typeof plan.toJson === "function") return plan.toJson();
    return pyJsonDumps(plan.toDict(), { ensureAscii: false, separators: [",", ":"] });
}

// Python `TopologyPlan.model_validate_json(text)`.
function _plan_validate_json(text) {
    if (typeof TopologyPlan.model_validate_json === "function") return TopologyPlan.model_validate_json(text);
    if (typeof TopologyPlan.modelValidateJson === "function") return TopologyPlan.modelValidateJson(text);
    if (typeof TopologyPlan.fromJson === "function") return TopologyPlan.fromJson(text);
    return new TopologyPlan(JSON.parse(text));
}

// Entries of a mapping, whether the port kept it a plain object or a Map.
function _entries(obj) {
    return obj instanceof Map ? [...obj.entries()] : Object.entries(obj);
}

// The key set of a mapping (Python `set(mapping)`).
function _key_set(obj) {
    return obj instanceof Map ? new Set(obj.keys()) : new Set(Object.keys(obj ?? {}));
}

// Entry count of a mapping (Python `bool(mapping)` / truthiness).
function _map_size(obj) {
    return obj instanceof Map ? obj.size : Object.keys(obj ?? {}).length;
}

export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _BRIDGE_PORT = ctx.port;
    const _DEPLOY_BATCH = DEPLOY_BATCH;
    const _file_bridge = ctx.file_bridge;
    const _bridge_identity = () => ctx.bridge_identity();
    const _bridge_pt_connected = () => ctx.bridge_pt_connected();
    const _ensure_bridge = () => ctx.ensure_bridge();
    const _pick_channel = () => ctx.pick_channel();
    const _channel_send = (payload) => ctx.channel_send(payload);
    const _stale_client_message = () => ctx.stale_client_message();
    const _bridge_send_and_wait = (js, timeout) => ctx.send_and_wait(js, timeout);
    const _check_bridge = () => ctx.check_bridge();
    const _js_guard = BridgeContext.js_guard;

    // ------------------------------------------------------------------
    // LIVE DEPLOY (direct to Packet Tracer)
    // ------------------------------------------------------------------

    // Defined before pt_full_build, which calls it the way the Python
    // pt_full_build calls the pt_live_deploy closure directly.

    const pt_live_deploy = async (args = {}) => {
        let { plan_json = "", command_delay = 0.0, plan_path = "" } = args;
        if (command_delay < 0.0) {
            command_delay = 0.0;
        }

        // Needs a channel to PT (HTTP with the window open, or file with the
        // Script Engine alive). _check_bridge starts HTTP and applies the patches
        // over the right channel.
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        let plan;
        try {
            plan = _plan_validate_json(read_plan_source(plan_json, plan_path));
        } catch (exc) {
            return `Invalid plan: ${exc.message}`;
        }
        // Same rules as pt_validate_plan: an invalid plan deploys as a broken topology.
        const problems = validate_plan(plan).errors;
        if (problems.length) {
            return "Not deployed: the plan has validation errors (see pt_validate_plan).\n" + problems.map(
                (e) => `  ERROR [${_code_value(e)}]: ${e.message}`).join("\n");
        }

        // A name already on the canvas would be created a second time (PT allows
        // duplicate names) while links and config land on the old device, and the
        // getDevice(name) verification below would still say "verified".
        const live = await _bridge_send_and_wait(_LIVE_NAMES_JS, 5.0);
        let live_names;
        try {
            live_names = live ? JSON.parse(live) : [];
        } catch (e) {
            live_names = [];
        }
        const taken = name_collisions(plan.devices.map((d) => d.name), live_names);
        if (taken.length) {
            return (
                "Not deployed: the canvas already has device(s) named "
                + taken.join(", ")
                + ". Deploying would create duplicates with the same names. Start from an "
                + "empty canvas (File > New in Packet Tracer), remove them with "
                + "pt_delete_device, or edit the existing topology with pt_add_device / "
                + "pt_add_link instead."
            );
        }

        const script = generate_executable_script(plan);
        const commands = script.split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("//"));

        // Send in batches: it used to be one POST and a sleep(>=1s) PER COMMAND, so
        // a 40-command topology took 40 seconds for no technical reason.
        // Each command keeps its own guard inside the batch.
        let sent = 0;
        for (let i = 0; i < commands.length; i += _DEPLOY_BATCH) {
            const chunk = commands.slice(i, i + _DEPLOY_BATCH);
            const payload = chunk.map((c) => _js_guard(c)).join("\n");
            if (await _channel_send(payload)) {
                sent += chunk.length;
            }
            if (pyTruthy(command_delay)) {
                await sleep(command_delay * 1000);
            }
        }

        // --- Verify with ONE canvas read + Reconcile (fix F16): re-queue the commands of
        // the missing items (some devices, typically Laptop-PT, are silently dropped) and
        // read once more. The trips no longer grow with the topology, and an unreadable
        // canvas re-sends nothing (a late answer is not a missing device).
        const chk = await verify_and_reconcile(
            async (js, t) => await _bridge_send_and_wait(js, t),
            async (c) => await _channel_send(_js_guard(c)), plan, commands,
            command_delay);

        // DHCP requests lost while STP was settling: ask again. WiFi laptops are first
        // pinned to their LAN's AP, or they lease from whichever AP they heard first.
        let dhcp_lines = [];
        const send = async (js, t) => await _bridge_send_and_wait(js, t);
        const dhcp_hosts = dhcp_host_ports(plan, _key_set(static_host_ips(plan)));
        if (_map_size(dhcp_hosts) > 0) {
            await ctx.settle_stp();
            dhcp_lines = await pin_wifi_clients(send, plan);
            const [renewed, without_ip] = await renew_dhcp_leases(send, dhcp_hosts);
            dhcp_lines.push(...dhcp_lease_report(renewed, without_ip));
            dhcp_lines.push(...dhcp_address_report(plan, await read_host_ips(send, dhcp_hosts)));
        }

        const report = ["Topology deployed to Packet Tracer!", `  Commands sent: ${sent}`];
        if (!pyTruthy(chk["verified"])) {
            report.push("  ⚠ Could not read the canvas to verify it (PT busy?). Nothing "
                          + "was re-sent; check with pt_query_topology.");
        } else {
            report.push(`  Devices: ${chk['dev_ok']}/${plan.devices.length} verified`);
            if (pyTruthy(chk["reconciled_devices"]) || pyTruthy(chk["reconciled_links"])) {
                report.push(
                    `  ♻ Reconciled: ${chk['reconciled_devices'].length} device(s), `
                    + `${chk['reconciled_links'].length} link(s) re-added after being dropped.`
                );
            }
            if (pyTruthy(chk["dev_fail"])) {
                report.push(`  FAILED devices: ${chk['dev_fail'].join(", ")}`);
            }
            report.push(`  Links: ${chk['link_ok']}/${plan.links.length} verified`);
            if (pyTruthy(chk["link_fail"])) {
                report.push("  FAILED links:");
                for (const f of chk["link_fail"]) {
                    report.push(`    - ${f}`);
                }
            }
        }
        report.push(...dhcp_lines);

        return report.join("\n");
    };

    // ------------------------------------------------------------------
    // FULL BUILD
    // ------------------------------------------------------------------
    registry.tool("pt_full_build", async (args = {}) => {
        const {
            routers = 2,
            pcs_per_lan = 3,
            laptops_per_lan = 0,
            switches_per_router = 1,
            servers = 0,
            access_points = 0,
            has_wan = false,
            dhcp = true,
            routing = "static",
            router_model = "2911",
            switch_model = "2960-24TT",
            template = "multi_lan",
            deploy = true,
            floating_routes = false,
            ospf_process_id = 1,
            eigrp_as = 100,
            vlans = 0,
            dual_stack = false,
            ipv6_base = "2001:db8::/32",
            wireless_laptops = false,
        } = args;
        const request = new TopologyRequest({
            template: _topology_template(template),
            routers: routers,
            pcs_per_lan: pcs_per_lan,
            laptops_per_lan: laptops_per_lan,
            switches_per_router: switches_per_router,
            servers: servers,
            access_points: access_points,
            has_wan: has_wan,
            dhcp: dhcp,
            routing: _routing_protocol(routing),
            router_model: router_model,
            switch_model: switch_model,
            floating_routes: floating_routes,
            ospf_process_id: ospf_process_id,
            eigrp_as: eigrp_as,
            vlans: vlans,
            dual_stack: dual_stack,
            ipv6_base: ipv6_base,
            wireless_laptops: wireless_laptops,
        });
        const [plan, validation] = plan_from_request(request);
        // Fit the drawing to the user's real canvas, read only when this plan is going
        // to be deployed (an invalid plan sends nothing to PT).
        if (deploy && validation.is_valid) {
            const size = await ctx.canvas_size();
            if (pyTruthy(size)) {
                fit_plan_to_canvas(plan, request, size);
            }
        }
        const explanation = explain_plan(plan);
        const estimation = estimate_from_plan(plan);

        const parts = [];

        // --- Summary ---
        parts.push("=".repeat(60));
        parts.push("TOPOLOGY SUMMARY");
        parts.push("=".repeat(60));
        parts.push(`Devices: ${plan.devices.length}`);
        parts.push(`Links: ${plan.links.length}`);
        parts.push(`DHCP Pools: ${plan.dhcp_pools.length}`);
        parts.push(`Static routes: ${plan.static_routes.length}`);
        parts.push(`OSPF configs: ${plan.ospf_configs.length}`);
        parts.push(`RIP configs: ${plan.rip_configs.length}`);
        parts.push(`EIGRP configs: ${plan.eigrp_configs.length}`);
        parts.push("");

        // --- Validation ---
        if (validation.is_valid) {
            parts.push("✅ Validation: PASS");
        } else {
            parts.push("❌ Validation: FAIL");
            for (const err of validation.errors) {
                parts.push(`  ERROR [${_code_value(err)}]: ${err.message}`);
            }
        }
        if (pyTruthy(validation.warnings)) {
            for (const warn of validation.warnings) {
                parts.push(`  ⚠️ [${_code_value(warn)}]: ${warn.message}`);
            }
        }
        parts.push("");

        // --- Explanation ---
        parts.push("=".repeat(60));
        parts.push("EXPLANATION");
        parts.push("=".repeat(60));
        for (const e of explanation) {
            parts.push(`• ${e}`);
        }
        parts.push("");

        // --- Addressing table ---
        parts.push("=".repeat(60));
        parts.push("ADDRESSING TABLE");
        parts.push("=".repeat(60));
        // A DHCP host's address here is only the expected lease; the real one is
        // listed after the deploy ("DHCP leases (live)").
        const dhcp_named = _key_set(dhcp_host_ports(plan, _key_set(static_host_ips(plan))));
        for (const dev of plan.devices) {
            if (pyTruthy(dev.interfaces)) {
                parts.push(`${dev.name} (${dev.model}):`);
                for (const [iface, ip] of _entries(dev.interfaces)) {
                    const tag = dhcp_named.has(dev.name) ? "  (DHCP, expected lease)" : "";
                    parts.push(`  ${iface}: ${ip}${tag}`);
                }
                if (pyTruthy(dev.gateway)) {
                    parts.push(`  Gateway: ${dev.gateway}`);
                }
            } else if (pyTruthy(dev.gateway)) {
                parts.push(`${dev.name}: DHCP (Gateway: ${dev.gateway})`);
            }
        }
        parts.push("");

        // --- Script PTBuilder ---
        parts.push("=".repeat(60));
        parts.push("SCRIPT PTBUILDER");
        parts.push("=".repeat(60));
        parts.push(generate_full_script(plan));
        parts.push("");

        // --- Configs CLI ---
        const configs = generate_all_configs(plan);
        parts.push("=".repeat(60));
        parts.push("CLI CONFIGURATIONS");
        parts.push("=".repeat(60));
        for (const [device_name, cli_block] of _entries(configs)) {
            parts.push(`\n--- ${device_name} ---`);
            parts.push(cli_block);
        }

        const pcs = plan.devices.filter((d) => ["pc", "server", "laptop"].includes(d.category));
        if (pcs.length) {
            parts.push(`\n--- Hosts ---`);
            const use_dhcp = pyTruthy(plan.dhcp_pools);
            for (const pc of pcs) {
                parts.push(generate_pc_config(pc, use_dhcp));
            }
        }

        // --- Suggested checks ---
        if (pyTruthy(plan.validations)) {
            parts.push("");
            parts.push("=".repeat(60));
            parts.push("SUGGESTED CHECKS");
            parts.push("=".repeat(60));
            for (const v of plan.validations) {
                parts.push(`  ${v.check_type}: ${v.from_device} → ${v.to_target} (expected: ${v.expected})`);
            }
        }

        // --- Deploy ---
        if (deploy && !validation.is_valid) {
            // A plan that failed validation used to be deployed anyway, under a
            // report that listed its errors: half a topology on the canvas.
            parts.push("", "NOT DEPLOYED: the plan failed validation (errors above). "
                      + "Fix them, or pt_fix_plan, then deploy.");
        } else if (deploy) {
            parts.push("");
            parts.push("=".repeat(60));
            parts.push("DEPLOYMENT TO PACKET TRACER");
            parts.push("=".repeat(60));
            const project_name = `build_${routers}r_${pcs_per_lan}pc`;

            // With a live channel it has to really deploy. This used to ALWAYS
            // go to the clipboard, so the "full" pipeline ended with an empty
            // canvas even with the bridge connected: the user saw
            // "✅ Validation: PASS" and there was nothing in PT.
            // Start the bridge first: on a fresh server it does not exist yet, and
            // the build fell back to the clipboard while PT was a second away.
            await _ensure_bridge();
            if ((await _pick_channel()) !== "") {
                parts.push(await pt_live_deploy({ plan_json: _plan_dump_json(plan) }));
                parts.push("");
                const export_result = new ManualExecutor("projects").execute(
                    plan, project_name
                );
                parts.push(`Files exported to: ${export_result['project_dir']}`);
                parts.push("  CLI configs in *_config.txt files");
            } else {
                const deploy_exec = new DeployExecutor("projects");
                const deploy_result = deploy_exec.execute(plan, project_name);
                if (deploy_result["clipboard"]) {
                    parts.push("SCRIPT COPIED TO THE CLIPBOARD");
                    parts.push("");
                    parts.push("Instructions:");
                    parts.push("  1. Open Packet Tracer");
                    parts.push("  2. Go to Extensions > Scripting");
                    parts.push("  3. Paste (Ctrl+V) and run");
                    parts.push("");
                    parts.push(`Files exported to: ${deploy_result['project_dir']}`);
                    parts.push("  CLI configs in *_config.txt files");
                } else {
                    parts.push(`Files exported to: ${deploy_result['project_dir']}`);
                    parts.push("  Copy topology.js and paste it in PT > Extensions > Scripting");
                }
                parts.push("");
                parts.push(deploy_result["instructions"]);
            }
        }

        // --- Plan JSON ---
        parts.push("");
        parts.push("=".repeat(60));
        parts.push("PLAN JSON (for programmatic use)");
        parts.push("=".repeat(60));
        parts.push(_plan_dump_json(plan));

        return parts.join("\n");
    });

    registry.tool("pt_live_deploy", pt_live_deploy);

    // report_result_js() lives in live_bridge.py (one single place) and is generated on
    // demand because it carries the token. The HTTP branch of _bridge_send_and_wait
    // prepends it to the command; over the file channel the Script Engine injects it.

    // The bridge is started on demand from the tools that need it.
    // It used to start here, when registering tools: importing the server opened a
    // socket even if nobody was going to use live deploy, needlessly widening the
    // window during which the port is listening.

    registry.tool("pt_bridge_status", async (args = {}) => {
        const identity = await _bridge_identity();
        if (identity === "foreign") {
            return (
                `Port ${_BRIDGE_PORT} is occupied by a process that is NOT this `
                + "MCP server's bridge (likely a leftover MCP server from an earlier "
                + "session).\n"
                + "Refusing to send commands to it — they would run in whatever is "
                + "listening there.\n"
                + "Kill that process (or restart the MCP server) and retry."
            );
        }

        const http_up = await _ensure_bridge();
        let http_connected = false;
        if (http_up) {
            http_connected = await _bridge_pt_connected();
        }
        const file_alive = _file_bridge.pt_alive();

        // Real headers from PT's webview (includes the Origin: pt-sm:), useful
        // for diagnosis and for tuning CORS later on.
        let hdr = "";
        if (ctx.instance !== null && ctx.instance !== undefined && pyTruthy(ctx.instance._client_headers)) {
            hdr = `\nPT client headers: ${pyStr(ctx.instance._client_headers)}`;
        }

        if (http_connected && file_alive) {
            return (
                "CONNECTED over both channels:\n"
                + `  • HTTP (window open) — http://127.0.0.1:${_BRIDGE_PORT}\n`
                + "  • file-bridge (Script Engine, keeps working if you close the window)" + hdr
            );
        }
        if (http_connected) {
            return (
                "CONNECTED over HTTP (MCP Control Center window open) — "
                + `http://127.0.0.1:${_BRIDGE_PORT}.\n`
                + "Note: the file-bridge has not reported a heartbeat yet; if you close the "
                + "window, wait a few seconds for it to take over." + hdr
            );
        }
        if (file_alive) {
            return (
                "CONNECTED over file-bridge (the window is closed, but PT is still "
                + "open with the extension). Deployment works the same, a bit "
                + "slower than over HTTP. Open MCP Control Center if you want the HTTP "
                + "channel and the log panel."
            );
        }

        // No channel.
        if (ctx.instance !== null && ctx.instance !== undefined && ctx.instance.saw_recent_unauthorized) {
            return _stale_client_message();
        }

        let warn = "";
        if (token_was_rotated()) {
            warn = (
                "\n\nNOTE: the saved token was missing or corrupt and was "
                + "regenerated. Reopen the extension so it rereads it."
            );
        }
        if (token_is_ephemeral()) {
            warn += (
                "\n\nWARNING: the token could not be written to disk, so "
                + "it changes on every restart."
            );
        }

        return (
            "Packet Tracer is NOT connected over any channel.\n"
            + "Open PT with the MCP Control Center extension installed "
            + "(Extensions > MCP BUILDER). With the window open it uses HTTP; if you "
            + "close it, the file-bridge takes over while PT stays open." + warn
        );
    });

    registry.tool("pt_verify_connectivity", async (args = {}) => {
        const { from_device, to_ip, count = 4, timeout_s = PING_TIMEOUT_S } = args;
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        // Links created moments ago are still in STP listening/learning: a ping now
        // is lost and reads as a fault. Fast-forward past it (or sleep it out).
        const stp_wait = await ctx.settle_stp();
        const waited = stp_wait > 0 ? `\n(waited ${pyRound(stp_wait)}s for STP on links created moments ago)` : "";

        // The JS lives in `console_ping_arm_js` / `console_ping_poll_js` (module
        // level) so it can be tested without a bridge that `getCommandPrompt`, which
        // only exists on hosts and broke every IOS ping, never creeps back in.
        const armed = await _bridge_send_and_wait(
            console_ping_arm_js(from_device, to_ip), 8.0
        );
        if (armed === null || armed === undefined) {
            return "No answer from PT (timeout) while starting the ping.";
        }
        if (!armed.startsWith("BASE:")) {
            return `Could not start the ping: ${armed}`;
        }
        const _base_s = armed.slice(5).trim();
        if (!/^[+-]?\d+$/.test(_base_s)) {
            throw new Error(`invalid literal for int() with base 10: '${armed.slice(5)}'`);
        }
        const base = parseInt(_base_s, 10);

        const poll = console_ping_poll_js(from_device, base);

        const deadline = monotonic() + timeout_s;
        while (monotonic() < deadline) {
            await sleep(600);
            const r = await _bridge_send_and_wait(poll, 5.0);
            if (r === null || r === undefined) {
                continue;
            }
            if (r.startsWith("DONE:")) {
                const stat = r.slice(5);
                const verdict = {
                    "ok": "CONNECTIVITY OK",
                    // Partial loss: it used to be reported as OK, so
                    // 1 of 4 packets looked the same as 4 of 4.
                    "partial": "PARTIAL CONNECTIVITY (packet loss)",
                    "none": "NO CONNECTIVITY",
                }[_classify_ping(stat)];
                return `${from_device} → ${to_ip}: ${verdict}\n${stat}${waited}`;
            }
        }

        return ping_no_result_message(from_device, to_ip, timeout_s) + waited;
    });

    registry.tool("pt_save_project", async (args = {}) => {
        const { filename, overwrite = false } = args;
        let { directory = "" } = args;
        const err = await _check_bridge();
        if (err) {
            return err;
        }
        try {
            directory = resolve_save_dir(directory);
        } catch (exc) {
            return `Not saved: ${exc.message}`;
        }

        let name = safe_name_component(filename.trim(), "topology");
        if (!name.toLowerCase().endsWith(".pkt")) {
            name += ".pkt";
        }
        // PT shares this machine's disk: refuse early when the target is visible here.
        // The JS repeats the check for PT's default folder, which only PT knows.
        if (pyTruthy(directory.trim()) && !pyTruthy(overwrite) && save_target_exists(directory.trim(), name)) {
            return `Not saved: ${name} already exists in ${directory.trim()}. Pass overwrite=True to replace it.`;
        }

        const js = save_project_js(directory.trim(), name, overwrite);
        const result = await _bridge_send_and_wait(js, 20.0);
        if (result === null || result === undefined) {
            return "No answer from PT (timeout) while saving.";
        }
        if (result.startsWith("OK:")) {
            const rest = result.slice(3);
            const idx = rest.lastIndexOf("|");
            const path_str = idx >= 0 ? rest.slice(0, idx) : "";
            const size = idx >= 0 ? rest.slice(idx + 1) : rest;
            return `Project saved to ${path_str} (${size} bytes).`;
        }
        if (result.startsWith("EXISTS:")) {
            return `Not saved: ${result.slice(7)} already exists. Pass overwrite=True to replace it.`;
        }
        return `PT error while saving: ${result}`;
    });

    registry.tool("pt_open_project", async (args = {}) => {
        const { path: open_path } = args;
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        let target;
        try {
            target = String(resolve_open_path(open_path)).replaceAll("\\", "/");
        } catch (exc) {
            const msg = exc.message;
            return msg.startsWith("The file") ? msg : `Not opened: ${msg}`;
        }

        const result = await _bridge_send_and_wait(file_open_js(target), 30.0);
        if (result === null || result === undefined) {
            return "No answer from PT (timeout) while opening.";
        }
        if (result.startsWith("ERR:")) {
            return `PT error while opening: ${result}`;
        }
        let data;
        try {
            data = JSON.parse(result);
        } catch (e) {
            return `PT error while opening: ${result}`;
        }
        const [opened, why] = file_open_outcome(target, data);
        if (!opened) {
            return `Not opened: ${target} (${why}).`;
        }
        // Re-read the canvas in a separate call, after the open settled.
        const count_raw = await _bridge_send_and_wait(DEVICE_COUNT_JS, 10.0);
        let count = null;
        if (pyTruthy(count_raw)) {
            const stripped = count_raw.replace(/^-+/, "");
            if (stripped.length > 0 && /^\d+$/.test(stripped) && parseInt(count_raw, 10) >= 0) {
                count = count_raw;
            }
        }
        return (`Project opened: ${target} (${why}). Devices on the canvas: `
                + `${pyStr(data["before"])} before → ${count !== null ? count : pyStr(data["after"])} now.`);
    });
}
