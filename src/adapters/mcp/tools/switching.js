// Device-config tools sent as IOS CLI: VLANs, STP, port security, hardening, interface tuning, EtherChannel, VLAN read-back.

import { build_vlan_plan, apply_vlan_uc } from "../../../application/use_cases/apply_vlan.js";
import { apply_stp_uc, apply_port_security_uc } from "../../../application/use_cases/apply_switch_security.js";
import { STPConfig, PortSecurityConfig } from "../../../domain/models/switch_security.js";
import { build_hardening_config, apply_hardening_uc } from "../../../application/use_cases/apply_hardening.js";
import { apply_interface_tuning_uc } from "../../../application/use_cases/apply_interface_tuning.js";
import { InterfaceTuning } from "../../../domain/models/interface_tuning.js";
import { apply_etherchannel_uc } from "../../../application/use_cases/apply_etherchannel.js";
import { EtherChannelConfig } from "../../../domain/models/etherchannel.js";
import { IosApplyCheck, verification_summary } from "../../../infrastructure/execution/ios_verify.js";
import { select_devices, vlans_report } from "../../../domain/services/convergence.js";
import { vlans_js } from "../../../infrastructure/generator/state_js.js";
import { TIMEOUT_MSG } from "../bridge_context.js";
import { pyStr } from "../../../shared/pycompat.js";
import { reply_json } from "../../../shared/utils.js";


export async function apply_reply(result, label, bridge_ok, dry_run, check, sends = null) {
    /** Reply of a verified CLI apply tool: validation, then what IOS accepted. */
    // The use cases are synchronous (like Python) but the verified sends are
    // not: settle them first so `sent` and the verification report are real.
    if (sends && sends.length) {
        result["sent"] = (await Promise.all(sends)).every(Boolean);
    }
    const summary = [];
    summary.push(result["valid"] ? `✅ ${label} valid.`
                   : `❌ ${label}: ${result['errors'].length} error(s).`);
    const verification = check.report();
    if (dry_run) {
        summary.push("dry_run mode — NOT sent to the bridge.");
    } else if (result["valid"] && !bridge_ok) {
        summary.push("⚠ Bridge not connected — payload generated but NOT sent.");
    } else if (result["valid"]) {
        summary.push(verification_summary(verification));
    }
    return reply_json({
        "summary": summary.join("\n"),
        "valid": result["valid"],
        "errors": result["errors"],
        "warnings": result["warnings"],
        "cli_lines": result["cli_lines"],
        "js_payload": result["js_payload"],
        "sent": result["sent"],
        "dry_run": result["dry_run"],
        ...verification,
    });
}


export function invalid_input_reply(label, exc) {
    /** Reply for arguments that do not even fit the model (e.g. a dict missing a key). */
    const message = pyStr(exc && exc.message !== undefined ? exc.message : exc).split("\n");
    return reply_json({
        "summary": `❌ ${label}: invalid arguments.`,
        "valid": false,
        "errors": [{"error_code": "VALIDATION_ERROR", "device": "",
                    "message": message.slice(0, 6).map((m) => m.trim()).join(" "),
                    "suggestion": "Check the parameter shapes in the tool description."}],
        "warnings": [], "cli_lines": [], "sent": false,
        "verified": false, "verification": "not_sent",
    });
}


export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _TIMEOUT_MSG = TIMEOUT_MSG;
    const _pick_channel = async () => await ctx.pick_channel();
    const _bridge_send_and_wait = async (js, timeout) => await ctx.send_and_wait(js, timeout);
    const _check_bridge = async () => await ctx.check_bridge();
    const _query_pt_devices = async () => await ctx.live_devices();

    // Synchronous use cases (like Python) get a pre-fetched topology callable
    // and a tracked verified send; apply_reply awaits the sends.
    async function _uc_env(bridge_ok, check, dry_run) {
        const devices = bridge_ok ? await _query_pt_devices() : null;
        const sends = [];
        return {
            query_fn: bridge_ok ? () => devices : null,
            send_fn: bridge_ok && !dry_run ? (js) => { const pr = check.send(js); sends.push(pr); return pr; } : null,
            sends,
        };
    }

    registry.tool("pt_apply_vlan", async (args) => {
        const switch_ = args.switch !== undefined ? args.switch : "";
        const router = args.router !== undefined ? args.router : "";
        const vlans = args.vlans !== undefined ? args.vlans : null;
        const access_ports = args.access_ports !== undefined ? args.access_ports : null;
        const trunks = args.trunks !== undefined ? args.trunks : null;
        const subinterfaces = args.subinterfaces !== undefined ? args.subinterfaces : null;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const plan = build_vlan_plan(
            switch_, router, vlans, access_ports, trunks, subinterfaces,
        );

        const bridge_ok = (await _pick_channel()) !== "";
        const check = new IosApplyCheck(_bridge_send_and_wait);
        const { query_fn, send_fn, sends } = await _uc_env(bridge_ok, check, dry_run);

        const result = apply_vlan_uc(plan, query_fn, send_fn, dry_run);
        return apply_reply(result, `VLAN config (${plan.vlans.length} VLAN(s))`,
                               bridge_ok, dry_run, check, sends);
    });

    registry.tool("pt_apply_stp", async (args) => {
        const switch_ = args.switch;
        const mode = args.mode !== undefined ? args.mode : "rapid-pvst";
        const root_primary_vlans = args.root_primary_vlans !== undefined ? args.root_primary_vlans : null;
        const priority = args.priority !== undefined ? args.priority : null;
        const portfast_ports = args.portfast_ports !== undefined ? args.portfast_ports : null;
        const bpduguard_ports = args.bpduguard_ports !== undefined ? args.bpduguard_ports : null;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const priority_int = {};
        for (const [k, v] of Object.entries(priority || {})) {
            priority_int[String(Math.trunc(Number(k)))] = Math.trunc(Number(v));
        }
        const cfg = new STPConfig({
            switch: switch_, mode: mode,
            root_primary_vlans: root_primary_vlans || [],
            priority: priority_int,
            portfast_ports: portfast_ports || [],
            bpduguard_ports: bpduguard_ports || [],
        });
        const bridge_ok = (await _pick_channel()) !== "";
        const check = new IosApplyCheck(_bridge_send_and_wait);
        const { query_fn, send_fn, sends } = await _uc_env(bridge_ok, check, dry_run);
        const result = apply_stp_uc(cfg, query_fn, send_fn, dry_run);
        return apply_reply(result, "STP", bridge_ok, dry_run, check, sends);
    });

    registry.tool("pt_apply_port_security", async (args) => {
        const switch_ = args.switch;
        const port = args.port;
        const max_mac = args.max_mac !== undefined ? args.max_mac : 1;
        const violation = args.violation !== undefined ? args.violation : "shutdown";
        const sticky = args.sticky !== undefined ? args.sticky : true;
        const static_macs = args.static_macs !== undefined ? args.static_macs : null;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const cfg = new PortSecurityConfig({
            switch: switch_, port: port, max_mac: max_mac,
            violation: violation, sticky: sticky, static_macs: static_macs || [],
        });
        const bridge_ok = (await _pick_channel()) !== "";
        const check = new IosApplyCheck(_bridge_send_and_wait);
        const { query_fn, send_fn, sends } = await _uc_env(bridge_ok, check, dry_run);
        const result = apply_port_security_uc(cfg, query_fn, send_fn, dry_run);
        return apply_reply(result, "Port-security", bridge_ok, dry_run, check, sends);
    });

    registry.tool("pt_apply_hardening", async (args) => {
        const device = args.device;
        const hostname = args.hostname !== undefined ? args.hostname : "";
        const banner_motd = args.banner_motd !== undefined ? args.banner_motd : "";
        const enable_secret = args.enable_secret !== undefined ? args.enable_secret : "";
        const users = args.users !== undefined ? args.users : null;
        const ssh = args.ssh !== undefined ? args.ssh : null;
        const service_password_encryption = args.service_password_encryption !== undefined ? args.service_password_encryption : true;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const cfg = build_hardening_config(
            device, hostname, banner_motd, enable_secret, users, ssh,
            service_password_encryption,
        );
        const bridge_ok = (await _pick_channel()) !== "";
        const check = new IosApplyCheck(_bridge_send_and_wait);
        const { query_fn, send_fn, sends } = await _uc_env(bridge_ok, check, dry_run);
        const result = apply_hardening_uc(cfg, query_fn, send_fn, dry_run);
        return apply_reply(result, "Hardening", bridge_ok, dry_run, check, sends);
    });

    registry.tool("pt_apply_interface_tuning", async (args) => {
        const router = args.router;
        const interface_ = args.interface;
        const clock_rate = args.clock_rate !== undefined ? args.clock_rate : null;
        const bandwidth = args.bandwidth !== undefined ? args.bandwidth : null;
        const ospf_cost = args.ospf_cost !== undefined ? args.ospf_cost : null;
        const ospf_priority = args.ospf_priority !== undefined ? args.ospf_priority : null;
        const ospf_hello_interval = args.ospf_hello_interval !== undefined ? args.ospf_hello_interval : null;
        const ospf_dead_interval = args.ospf_dead_interval !== undefined ? args.ospf_dead_interval : null;
        const ospf_auth_key = args.ospf_auth_key !== undefined ? args.ospf_auth_key : null;
        const ospf_md5_key_id = args.ospf_md5_key_id !== undefined ? args.ospf_md5_key_id : null;
        const ospf_md5_key = args.ospf_md5_key !== undefined ? args.ospf_md5_key : null;
        const delay = args.delay !== undefined ? args.delay : null;
        const ospf_network = args.ospf_network !== undefined ? args.ospf_network : null;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const cfg = new InterfaceTuning({
            router: router, interface: interface_, clock_rate: clock_rate,
            bandwidth: bandwidth, ospf_cost: ospf_cost, ospf_priority: ospf_priority,
            ospf_hello_interval: ospf_hello_interval,
            ospf_dead_interval: ospf_dead_interval, ospf_auth_key: ospf_auth_key,
            ospf_md5_key_id: ospf_md5_key_id, ospf_md5_key: ospf_md5_key,
            delay: delay, ospf_network: ospf_network,
        });
        const bridge_ok = (await _pick_channel()) !== "";
        const check = new IosApplyCheck(_bridge_send_and_wait);
        const { query_fn, send_fn, sends } = await _uc_env(bridge_ok, check, dry_run);
        const result = apply_interface_tuning_uc(cfg, query_fn, send_fn, dry_run);
        return apply_reply(result, "Interface tuning", bridge_ok, dry_run, check, sends);
    });

    registry.tool("pt_apply_etherchannel", async (args) => {
        const switch_ = args.switch;
        const ports = args.ports;
        const group = args.group !== undefined ? args.group : 1;
        const mode = args.mode !== undefined ? args.mode : "active";
        const trunk = args.trunk !== undefined ? args.trunk : false;
        const allowed_vlans = args.allowed_vlans !== undefined ? args.allowed_vlans : null;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        let cfg;
        try {
            cfg = new EtherChannelConfig({switch: switch_, ports: [...(ports || [])], group: group,
                                     mode: mode, trunk: trunk, allowed_vlans: allowed_vlans});
        } catch (exc) {
            return invalid_input_reply("EtherChannel", exc);
        }
        const bridge_ok = (await _pick_channel()) !== "";
        const check = new IosApplyCheck(_bridge_send_and_wait);
        const { query_fn, send_fn, sends } = await _uc_env(bridge_ok, check, dry_run);
        const result = apply_etherchannel_uc(cfg, query_fn, send_fn, dry_run);
        return apply_reply(result, `EtherChannel Port-channel${group} (${cfg.protocol()})`,
                           bridge_ok, dry_run, check, sends);
    });

    // ------------------------------------------------------------------
    // VLANs — read from the switch's VlanManager, not from the plan
    // ------------------------------------------------------------------

    registry.tool("pt_read_vlans", async (args) => {
        const switch_ = args.switch;
        if (!switch_.trim()) {
            return "Pass the switch name. Use pt_query_topology to see the real names.";
        }
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const raw = await _bridge_send_and_wait(vlans_js(switch_.trim()), 10.0);
        if (raw === null || raw === undefined) {
            return _TIMEOUT_MSG;
        }
        if (raw.startsWith("ERROR:")) {
            return `PT error: ${raw}`;
        }
        let data;
        try {
            data = JSON.parse(raw);
        } catch (exc) {
            return `Unreadable reply from PT: ${exc.message !== undefined ? exc.message : exc}`;
        }

        const devices = select_devices(data, switch_.trim(), "VlanManager");
        if (typeof devices === "string") {
            return devices;
        }
        return reply_json(vlans_report(devices[0]));
    });
}
