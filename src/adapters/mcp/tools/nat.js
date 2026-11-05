// NAT/PAT tools: apply and remove address translation.

import { build_nat_config, apply_nat_uc, remove_nat_uc } from "../../../application/use_cases/apply_nat.js";
import { IosApplyCheck, verification_summary } from "../../../infrastructure/execution/ios_verify.js";
import { reply_json } from "../../../shared/utils.js";


export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _pick_channel = async () => await ctx.pick_channel();
    const _query_pt_devices = async () => await ctx.live_devices();
    const _bridge_send_payload = async (js) => await ctx.send_payload(js);
    const _bridge_send_and_wait = async (js, timeout) => await ctx.send_and_wait(js, timeout);

    // ------------------------------------------------------------------
    // NAT / PAT — apply and remove address translation through the bridge
    // ------------------------------------------------------------------

    registry.tool("pt_apply_nat", async (args) => {
        const router = args.router;
        const mode = args.mode;
        const inside_interface = args.inside_interface;
        const outside_interface = args.outside_interface;
        const static_mappings = args.static_mappings !== undefined ? args.static_mappings : null;
        const inside_networks = args.inside_networks !== undefined ? args.inside_networks : null;
        const acl_number = args.acl_number !== undefined ? args.acl_number : "1";
        const pool_name = args.pool_name !== undefined ? args.pool_name : "NAT-POOL";
        const pool_start = args.pool_start !== undefined ? args.pool_start : "";
        const pool_end = args.pool_end !== undefined ? args.pool_end : "";
        const pool_netmask = args.pool_netmask !== undefined ? args.pool_netmask : "";
        const use_interface_overload = args.use_interface_overload !== undefined ? args.use_interface_overload : false;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const config = build_nat_config(
            router, mode, inside_interface, outside_interface,
            static_mappings, inside_networks, acl_number, pool_name,
            pool_start, pool_end, pool_netmask, use_interface_overload,
        );

        const bridge_ok = (await _pick_channel()) !== "";
        // The use cases are synchronous (like Python): pre-fetch the live
        // devices, and track the verified sends to await them before reporting.
        const _devices = bridge_ok ? await _query_pt_devices() : null;
        const query_fn = bridge_ok ? () => _devices : null;
        const check = new IosApplyCheck(_bridge_send_and_wait);
        const _sends = [];
        const send_fn = bridge_ok && !dry_run ? (js) => { const p = check.send(js); _sends.push(p); return p; } : null;

        const result = apply_nat_uc(config, query_fn, send_fn, dry_run);
        if (_sends.length) {
            result["sent"] = (await Promise.all(_sends)).every(Boolean);
        }

        const summary_lines = [];
        const mode_label = ({"static": "Static NAT", "dynamic": "Dynamic NAT", "pat": "PAT/Overload"})[mode] !== undefined
            ? ({"static": "Static NAT", "dynamic": "Dynamic NAT", "pat": "PAT/Overload"})[mode] : mode;
        if (result["valid"]) {
            summary_lines.push(`✅ ${mode_label} valid for router '${router}'.`);
        } else {
            summary_lines.push(`❌ ${mode_label}: ${result['errors'].length} error(s).`);
        }

        const verification = await check.report();
        if (dry_run) {
            summary_lines.push("dry_run mode — NOT sent to the bridge.");
        } else if (result["valid"] && !bridge_ok) {
            summary_lines.push("⚠ Bridge not connected — payload generated but NOT sent.");
        } else if (result["valid"]) {
            summary_lines.push(verification_summary(verification));
        }

        return reply_json({
            "summary": summary_lines.join("\n"),
            "mode": mode,
            "valid": result["valid"],
            "errors": result["errors"],
            "warnings": result["warnings"],
            "cli_lines": result["cli_lines"],
            "js_payload": result["js_payload"],
            "sent": result["sent"],
            "dry_run": result["dry_run"],
            ...verification,
        });
    });

    registry.tool("pt_remove_nat", async (args) => {
        const router = args.router;
        const mode = args.mode;
        const inside_interface = args.inside_interface;
        const outside_interface = args.outside_interface;
        const acl_number = args.acl_number !== undefined ? args.acl_number : "1";
        const pool_name = args.pool_name !== undefined ? args.pool_name : "";
        const static_mappings = args.static_mappings !== undefined ? args.static_mappings : null;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const bridge_ok = (await _pick_channel()) !== "";
        const _sends = [];
        const send_fn = bridge_ok && !dry_run ? (js) => { const p = _bridge_send_payload(js); _sends.push(p); return p; } : null;

        const result = remove_nat_uc(
            router, mode, inside_interface, outside_interface,
            acl_number, pool_name, static_mappings, send_fn, dry_run,
        );
        if (_sends.length) {
            result["sent"] = (await Promise.all(_sends)).every(Boolean);
        }

        const summary = [];
        if (!result["valid"]) {
            summary.push("❌ Rejected: " + result["errors"].map((e) => e["message"]).join("; "));
        } else if (dry_run) {
            summary.push(`dry_run mode — payload generated to remove NAT '${mode}' on '${router}'.`);
        } else if (result["sent"]) {
            summary.push(`📤 NAT '${mode}' removed on '${router}' through the bridge.`);
        } else if (!bridge_ok) {
            summary.push("⚠ Bridge not connected — payload generated but NOT sent.");
        } else {
            summary.push("⚠ Sending failed.");
        }

        return reply_json({
            "summary": summary.join("\n"),
            "valid": result["valid"],
            "errors": result["errors"],
            "router": result["router"],
            "mode": result["mode"],
            "js_payload": result["js_payload"],
            "sent": result["sent"],
            "dry_run": result["dry_run"],
        });
    });
}
