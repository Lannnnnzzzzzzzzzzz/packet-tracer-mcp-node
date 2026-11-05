// Router features sent as IOS CLI, each line verified: HSRP, BGP, QoS (MQC) and CME voice.

import { pyTruthy } from "../../../shared/pycompat.js";
import {
    apply_hsrp_uc, apply_bgp_uc, apply_qos_uc, build_bgp_config, build_qos_config,
} from "../../../application/use_cases/apply_router_features.js";
import { apply_voice_uc, build_voice_config } from "../../../application/use_cases/apply_voice.js";
import { restart_ip_phones_js } from "../../../infrastructure/generator/voice_cli_generator.js";
import { HsrpConfig } from "../../../domain/models/router_features.js";
import { IosApplyCheck } from "../../../infrastructure/execution/ios_verify.js";
import { apply_reply, invalid_input_reply } from "./switching.js";
import { reply_json } from "../../../shared/utils.js";


export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _pick_channel = async () => await ctx.pick_channel();
    const _bridge_send_and_wait = async (js, timeout) => await ctx.send_and_wait(js, timeout);
    const _query_pt_devices = async () => await ctx.live_devices();

    async function _apply(uc, cfg, label, dry_run) {
        const bridge_ok = (await _pick_channel()) !== "";
        const check = new IosApplyCheck(_bridge_send_and_wait);
        // Synchronous use cases (like Python): pre-fetched topology callable,
        // tracked verified sends (apply_reply awaits them before reporting).
        const devices = bridge_ok ? await _query_pt_devices() : null;
        const sends = [];
        const result = uc(cfg,
            bridge_ok ? () => devices : null,
            bridge_ok && !dry_run ? (js) => { const p = check.send(js); sends.push(p); return p; } : null,
            dry_run);
        return apply_reply(result, label, bridge_ok, dry_run, check, sends);
    }

    registry.tool("pt_apply_hsrp", async (args) => {
        const router = args.router;
        const interface_ = args.interface;
        const group = args.group;
        const virtual_ip = args.virtual_ip;
        const priority = args.priority !== undefined ? args.priority : 100;
        const preempt = args.preempt !== undefined ? args.preempt : true;
        const version = args.version !== undefined ? args.version : 2;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        let cfg;
        try {
            cfg = new HsrpConfig({router: router, interface: interface_, group: group,
                             virtual_ip: virtual_ip, priority: priority,
                             preempt: preempt, version: version});
        } catch (exc) {
            return invalid_input_reply("HSRP", exc);
        }
        return _apply(apply_hsrp_uc, cfg, `HSRP group ${group}`, dry_run);
    });

    registry.tool("pt_apply_bgp", async (args) => {
        const router = args.router;
        const asn = args.asn;
        const neighbors = args.neighbors !== undefined ? args.neighbors : null;
        const networks = args.networks !== undefined ? args.networks : null;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        let cfg;
        try {
            cfg = await build_bgp_config(router, asn, neighbors, networks);
        } catch (exc) {
            return invalid_input_reply("BGP", exc);
        }
        return _apply(apply_bgp_uc, cfg, `BGP AS ${asn}`, dry_run);
    });

    registry.tool("pt_apply_qos", async (args) => {
        const router = args.router;
        const interface_ = args.interface;
        const policy_name = args.policy_name;
        const classes = args.classes;
        const direction = args.direction !== undefined ? args.direction : "output";
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        let cfg;
        try {
            cfg = await build_qos_config(router, interface_, policy_name, classes, direction);
        } catch (exc) {
            return invalid_input_reply("QoS", exc);
        }
        return _apply(apply_qos_uc, cfg, `QoS policy '${policy_name}'`, dry_run);
    });

    registry.tool("pt_apply_voice", async (args) => {
        const router = args.router;
        const source_ip = args.source_ip;
        const extensions = args.extensions;
        const max_ephones = args.max_ephones !== undefined ? args.max_ephones : 5;
        const max_dn = args.max_dn !== undefined ? args.max_dn : 5;
        const auto_assign = args.auto_assign !== undefined ? args.auto_assign : true;
        const voice_vlan = args.voice_vlan !== undefined ? args.voice_vlan : null;
        const switch_ = args.switch !== undefined ? args.switch : null;
        const access_ports = args.access_ports !== undefined ? args.access_ports : null;
        const dhcp_pool = args.dhcp_pool !== undefined ? args.dhcp_pool : null;
        const dhcp_network = args.dhcp_network !== undefined ? args.dhcp_network : null;
        const restart_phones = args.restart_phones !== undefined ? args.restart_phones : true;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        let cfg;
        try {
            cfg = await build_voice_config(
                router, source_ip, extensions, {max_ephones: max_ephones, max_dn: max_dn,
                auto_assign: auto_assign, voice_vlan: voice_vlan, switch: switch_,
                access_ports: access_ports, dhcp_pool: dhcp_pool, dhcp_network: dhcp_network});
        } catch (exc) {
            return invalid_input_reply("CME voice", exc);
        }
        const reply = await _apply(apply_voice_uc, cfg, `CME voice on ${router}`, dry_run);
        if (dry_run || !restart_phones || (await _pick_channel()) === "") {
            return reply;
        }
        const data = JSON.parse(reply);
        if (!data["sent"]) {
            return reply;
        }
        const raw = await _bridge_send_and_wait(restart_ip_phones_js(), 15.0);
        try {
            data["phones"] = raw ? JSON.parse(raw) : {"error": "no answer from PT"};
        } catch (e) {
            data["phones"] = {"error": `unreadable reply: ${raw ? raw.slice(0, 120) : raw}`};
        }
        return reply_json(data);
    });
}
