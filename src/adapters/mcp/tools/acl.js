// ACL tools: apply and remove access lists (numbered/named, object groups).

import { ACLBinding } from "../../../domain/models/acls.js";
import { build_acl_plan, apply_acl_uc, remove_acl_uc } from "../../../application/use_cases/apply_acl.js";
import { generate_acl_cli, generate_acl_statements } from "../../../infrastructure/generator/acl_cli_generator.js";
import { IosApplyCheck, verification_summary } from "../../../infrastructure/execution/ios_verify.js";
import { pyJsonDumps, pyStr, pyTruthy } from "../../../shared/pycompat.js";
import { reply_json } from "../../../shared/utils.js";


export function acl_object_outcome(added, expected) {
    /** Verification fields for pt_apply_acl_object: every statement must be accepted.
     *
     * addStatement returns false for a statement PT does not take; counting it as a
     * success used to report an ACL with missing rules as applied.
     */
    let n;
    try {
        if (added === null || added === undefined) throw new Error("bad");
        if (typeof added === "string" && !/^[+-]?\d+$/.test(added.trim())) throw new Error("bad");
        if (typeof added === "object") throw new Error("bad");
        n = Math.trunc(Number(added));
        if (Number.isNaN(n)) throw new Error("bad");
    } catch (e) {
        n = -1;
    }
    const ok = n === expected;
    return {"verified": ok, "verification": ok ? "verified" : "rejected",
            "statements_rejected": n >= 0 ? Math.max(expected - n, 0) : expected};
}


export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _pick_channel = async () => await ctx.pick_channel();
    const _bridge_send_and_wait = async (js, timeout) => await ctx.send_and_wait(js, timeout);
    const _query_pt_devices = async () => await ctx.live_devices();
    const _bridge_send_payload = async (js) => await ctx.send_payload(js);


    registry.tool("pt_apply_acl", async (args) => {
        const router = args.router;
        const name_or_number = args.name_or_number;
        const acl_type = args.acl_type;
        const entries = args.entries;
        const binding_interface = args.binding_interface !== undefined ? args.binding_interface : "";
        const binding_direction = args.binding_direction !== undefined ? args.binding_direction : "in";
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const plan = await build_acl_plan(router, name_or_number, acl_type, entries);
        let binding = null;
        if (pyTruthy(binding_interface)) {
            binding = new ACLBinding({
                router: router,
                interface: binding_interface,
                acl_id: String(name_or_number),
                direction: binding_direction,
            });
        }

        // Only queries PT if the bridge is connected (dynamic validation)
        const bridge_ok = (await _pick_channel()) !== "";
        // The use cases are synchronous (like Python): the live devices are
        // fetched once here and handed over as a plain callable, and the
        // verified sends are tracked so they can be awaited before reporting.
        const _devices = bridge_ok ? await _query_pt_devices() : null;
        const query_fn = bridge_ok ? () => _devices : null;
        const check = new IosApplyCheck(_bridge_send_and_wait);
        const _sends = [];
        const send_fn = bridge_ok && !dry_run ? (js) => { const p = check.send(js); _sends.push(p); return p; } : null;

        const result = apply_acl_uc(plan, binding, query_fn, send_fn, dry_run);
        if (_sends.length) {
            result["sent"] = (await Promise.all(_sends)).every(Boolean);
        }

        // Friendly summary
        const summary_lines = [];
        if (result["valid"]) {
            summary_lines.push(`✅ ACL '${plan.name_or_number}' valid (${plan.entries.length} rules).`);
        } else {
            summary_lines.push(`❌ ACL '${plan.name_or_number}' has ${result['errors'].length} error(s).`);
        }

        const verification = await check.report();
        if (dry_run) {
            summary_lines.push("dry_run mode — NOT sent to the bridge.");
        } else if (result["valid"] && !bridge_ok) {
            summary_lines.push("⚠ Bridge not connected — payload generated but NOT sent.");
        } else if (result["valid"]) {
            summary_lines.push(verification_summary(verification));
            if (binding && verification["verified"]) {
                summary_lines.push(`   Binding: ${binding.interface} ${binding.direction}`);
            }
        }

        return reply_json({
            "summary": summary_lines.join("\n"),
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

    registry.tool("pt_apply_acl_object", async (args) => {
        const router = args.router;
        const name_or_number = args.name_or_number;
        const acl_type = args.acl_type;
        const entries = args.entries;
        const binding_interface = args.binding_interface !== undefined ? args.binding_interface : "";
        const binding_direction = args.binding_direction !== undefined ? args.binding_direction : "in";
        const replace_existing = args.replace_existing !== undefined ? args.replace_existing : true;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const plan = await build_acl_plan(router, name_or_number, acl_type, entries);
        let binding = null;
        if (pyTruthy(binding_interface)) {
            binding = new ACLBinding({
                router: router,
                interface: binding_interface,
                acl_id: String(name_or_number),
                direction: binding_direction,
            });
        }

        const bridge_ok = (await _pick_channel()) !== "";

        // Static + topological validation
        const _devices2 = bridge_ok ? await _query_pt_devices() : null;
        const query_fn = bridge_ok ? () => _devices2 : null;
        const result = apply_acl_uc(
            plan, binding, query_fn,
            null,        // we don't send via CLI — we build our own JS
            true,        // validate without sending
        );

        if (!result["valid"]) {
            return reply_json({
                "summary": `❌ ACL '${plan.name_or_number}' has ${result['errors'].length} error(s).`,
                "valid": false,
                "errors": result["errors"],
                "warnings": result["warnings"],
                "sent": false,
                "dry_run": dry_run,
                "backend": "objects",
            });
        }

        // Bare statements (no "access-list NAME " prefix), the form addStatement takes
        const cli_lines = generate_acl_cli(plan);
        const statements = generate_acl_statements(plan);

        // Build the JS for AclProcess.addAcl + addStatement
        const name_js = pyJsonDumps(String(plan.name_or_number));
        const router_js = pyJsonDumps(router);
        const stmts_js = "[" + statements.map((s) => pyJsonDumps(s)).join(",") + "]";

        const js_lines = [
            `var d=ipc.network().getDevice(${router_js});`,
            'if(!d){reportResult(JSON.stringify({success:false,error:"router not found"}));return;}',
            'var ap=d.getProcess("AclProcess");',
            'if(!ap){reportResult(JSON.stringify({success:false,error:"AclProcess not available"}));return;}',
        ];
        if (replace_existing) {
            js_lines.push(`try{ap.removeAcl(${name_js});}catch(e){}`);
        }
        js_lines.push(
            `ap.addAcl(${name_js});`,
            `var acl=ap.getAcl(${name_js});`,
            'if(!acl){reportResult(JSON.stringify({success:false,error:"addAcl failed"}));return;}',
            `var stmts=${stmts_js};`,
            'var added=0;for(var i=0;i<stmts.length;i++){if(acl.addStatement(stmts[i]))added++;}',
        );

        let bound = "none";
        if (binding) {
            const iface_js = pyJsonDumps(binding.interface);
            const setter = binding.direction === "in" ? "setAclInID" : "setAclOutID";
            js_lines.push(
                `var p=d.getPort(${iface_js});`,
                `if(p){p.${setter}(${name_js});}`,
            );
            bound = `${binding.interface} ${binding.direction}`;
        }

        js_lines.push(
            'reportResult(JSON.stringify({success:true,added:added,cmdCount:acl.getCommandCount()}));'
        );

        const js = "(function(){" + js_lines.join("") + "})()";

        const payload = {
            "summary": "",
            "valid": true,
            "errors": [],
            "warnings": result["warnings"],
            "cli_lines": cli_lines,
            "statements": statements,
            "js_payload": js,
            "binding": bound,
            "sent": false,
            "dry_run": dry_run,
            "backend": "objects",
        };

        if (dry_run) {
            payload["summary"] = (
                `[dry_run] ACL '${plan.name_or_number}' ready: `
                + `${statements.length} statement(s) + binding=${bound}. JS NOT sent.`
            );
            return reply_json(payload);
        }

        if (!bridge_ok) {
            payload["summary"] = "⚠ Bridge not connected — payload generated but NOT sent.";
            return reply_json(payload);
        }

        const response = await _bridge_send_and_wait(js, 10.0);
        payload["verified"] = false;
        if (response === null || response === undefined) {
            payload["verification"] = "unverified";
            payload["summary"] = "⚠ No answer from PT: the result is UNVERIFIED.";
            return reply_json(payload);
        }

        try {
            const r = JSON.parse(response);
            if (r["success"]) {
                payload["sent"] = true;
                payload["added"] = r["added"] !== undefined ? r["added"] : null;
                payload["cmd_count"] = r["cmdCount"] !== undefined ? r["cmdCount"] : null;
                Object.assign(payload, acl_object_outcome(r["added"] !== undefined ? r["added"] : null, statements.length));
                const head = payload["verified"] ? "📤" : "❌ Partial:";
                payload["summary"] = (
                    `${head} ACL '${plan.name_or_number}' on '${router}' through AclProcess: `
                    + `${pyStr(r["added"] !== undefined && r["added"] !== null ? r["added"] : null)}/${statements.length} statements accepted. Binding=${bound}.`
                );
            } else {
                payload["summary"] = `PT error: ${r["error"] !== undefined && r["error"] !== null ? r["error"] : 'unknown'}`;
            }
        } catch (e) {
            payload["summary"] = `Unexpected reply: ${response}`;
        }

        return reply_json(payload);
    });

    registry.tool("pt_remove_acl_object", async (args) => {
        const router = args.router;
        const name_or_number = args.name_or_number;
        const binding_interface = args.binding_interface !== undefined ? args.binding_interface : "";
        const binding_direction = args.binding_direction !== undefined ? args.binding_direction : "in";
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const bridge_ok = (await _pick_channel()) !== "";

        const name_js = pyJsonDumps(String(name_or_number));
        const router_js = pyJsonDumps(router);

        const js_lines = [
            `var d=ipc.network().getDevice(${router_js});`,
            'if(!d){reportResult(JSON.stringify({success:false,error:"router not found"}));return;}',
            'var ap=d.getProcess("AclProcess");',
            'if(!ap){reportResult(JSON.stringify({success:false,error:"AclProcess not available"}));return;}',
        ];

        let bound_label = "none";
        if (pyTruthy(binding_interface)) {
            const iface_js = pyJsonDumps(binding_interface);
            const setter = binding_direction === "in" ? "setAclInID" : "setAclOutID";
            js_lines.push(
                `var p=d.getPort(${iface_js});`,
                `if(p){p.${setter}("");}`,
            );
            bound_label = `${binding_interface} ${binding_direction}`;
        }

        js_lines.push(
            `var removed=ap.removeAcl(${name_js});`,
            'reportResult(JSON.stringify({success:true,removed:removed}));',
        );

        const js = "(function(){" + js_lines.join("") + "})()";

        const payload = {
            "summary": "",
            "router": router,
            "acl_id": String(name_or_number),
            "binding": bound_label,
            "js_payload": js,
            "sent": false,
            "dry_run": dry_run,
            "backend": "objects",
        };

        if (dry_run) {
            payload["summary"] = (
                `[dry_run] payload generated to remove ACL '${name_or_number}' `
                + `on '${router}' (binding=${bound_label}). NOT sent.`
            );
            return reply_json(payload);
        }

        if (!bridge_ok) {
            payload["summary"] = "⚠ Bridge not connected — payload generated but NOT sent.";
            return reply_json(payload);
        }

        const response = await _bridge_send_and_wait(js, 10.0);
        if (response === null || response === undefined) {
            payload["summary"] = "No answer from PT.";
            return reply_json(payload);
        }

        try {
            const r = JSON.parse(response);
            if (r["success"]) {
                payload["sent"] = true;
                payload["removed"] = r["removed"] !== undefined ? r["removed"] : null;
                payload["summary"] = (
                    `📤 ACL '${name_or_number}' removed on '${router}' through AclProcess `
                    + `(removed=${pyStr(r["removed"] !== undefined && r["removed"] !== null ? r["removed"] : null)}, binding=${bound_label}).`
                );
            } else {
                payload["summary"] = `PT error: ${r["error"] !== undefined && r["error"] !== null ? r["error"] : 'unknown'}`;
            }
        } catch (e) {
            payload["summary"] = `Unexpected reply: ${response}`;
        }

        return reply_json(payload);
    });

    registry.tool("pt_remove_acl", async (args) => {
        const router = args.router;
        const name_or_number = args.name_or_number;
        const binding_interface = args.binding_interface !== undefined ? args.binding_interface : "";
        const binding_direction = args.binding_direction !== undefined ? args.binding_direction : "in";
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const bridge_ok = (await _pick_channel()) !== "";
        const _sends = [];
        const send_fn = bridge_ok && !dry_run ? (js) => { const p = _bridge_send_payload(js); _sends.push(p); return p; } : null;

        const result = remove_acl_uc(
            router, name_or_number, binding_interface, binding_direction, send_fn, dry_run,
        );
        if (_sends.length) {
            result["sent"] = (await Promise.all(_sends)).every(Boolean);
        }

        const summary = [];
        if (!result["valid"]) {
            summary.push("❌ Rejected: " + result["errors"].map((e) => e["message"]).join("; "));
        } else if (dry_run) {
            summary.push(`dry_run mode — payload generated to remove ACL '${name_or_number}' on '${router}'.`);
        } else if (result["sent"]) {
            summary.push(`📤 ACL '${name_or_number}' removed on '${router}' through the bridge.`);
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
            "acl_id": result["acl_id"],
            "js_payload": result["js_payload"],
            "sent": result["sent"],
            "dry_run": result["dry_run"],
        });
    });
}
