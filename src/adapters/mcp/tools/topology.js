// Live topology tools: query/export, delete/rename/move, validated add device/link, set port, raw JS.
// (Port of adapters/mcp/tools/topology.py)

import { BridgeContext, TIMEOUT_MSG } from "../bridge_context.js";
import { resolve_model, category_of_model } from "../../../infrastructure/catalog/devices.js";
import { CABLE_TYPES, cable_type_name, infer_cable } from "../../../infrastructure/catalog/cables.js";
import {
    delete_link_js, move_device_js, rename_device_js, topology_snapshot_js,
} from "../../../infrastructure/generator/topology_js.js";
import { format_export, format_query } from "../../../domain/services/topology_view.js";
import { bad_device_name, has_control_chars } from "../../../domain/rules/text_rules.js";
import { add_device_call, add_link_call } from "../../../infrastructure/generator/ptbuilder_generator.js";
import { WALK_JS } from "../../../infrastructure/generator/walk_js.js";
import { pyJsonDumps, pyStr, pyTruthy } from "../../../shared/pycompat.js";
import { reply_json } from "../../../shared/utils.js";

// Reader error codes -> the words a caller sees.
const _EDIT_ERRORS = {
    "device_not_found": "Device not found", "port_not_found": "Interface not found",
    "no_link": "No link on this interface",
};

export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _TIMEOUT_MSG = TIMEOUT_MSG;
    const _channel_send = (payload) => ctx.channel_send(payload);
    const _bridge_send_and_wait = (js, timeout) => ctx.send_and_wait(js, timeout);
    const _check_bridge = () => ctx.check_bridge();
    const _js_guard = BridgeContext.js_guard;

    // ------------------------------------------------------------------
    // QUERY / INTERACT with existing topology in PT
    // ------------------------------------------------------------------

    async function _snapshot() {
        /** Devices and links (with the real cable type) in one read, or the error text. */
        const err = await _check_bridge();
        if (err) {
            return err;
        }
        const raw = await _bridge_send_and_wait(topology_snapshot_js(), 15.0);
        if (raw === null || raw === undefined) {
            return _TIMEOUT_MSG;
        }
        if (raw.startsWith("ERROR:")) {
            return `PT error: ${raw}`;
        }
        try {
            return JSON.parse(raw);
        } catch (exc) {
            return `Unreadable reply from PT: ${exc.message}`;
        }
    }

    registry.tool("pt_query_topology", async (args = {}) => {
        const data = await _snapshot();
        return typeof data === "string" ? data : format_query(data);
    });

    registry.tool("pt_export_topology", async (args = {}) => {
        const data = await _snapshot();
        return typeof data === "string" ? data : format_export(data);
    });

    registry.tool("pt_delete_device", async (args = {}) => {
        const { device_name } = args;
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const js = (
            "try {"
            + `  var N = ${pyJsonDumps(device_name)};`
            + "  var dev = ipc.network().getDevice(N);"
            + "  if (!dev) { reportResult('ERROR:Device not found'); }"
            + "  else {"
            + "    var lw = ipc.appWindow().getActiveWorkspace().getLogicalWorkspace();"
            + "    if (typeof lw.removeDevice !== 'function') {"
            + "      reportResult('ERROR:removeDevice API not available in this PT build');"
            + "    } else {"
            + "      lw.removeDevice(dev.getName());"
            + "      var still = ipc.network().getDevice(N);"
            + "      reportResult(still ? 'ERROR:device still present after removeDevice' : 'OK:deleted');"
            + "    }"
            + "  }"
            + "} catch(e) { reportResult('ERROR:' + e); }"
        );
        const result = await _bridge_send_and_wait(js, 8.0);
        if (result === null || result === undefined) {
            return `No response from PT. Device '${device_name}' may not exist.`;
        }
        if (result.startsWith("ERROR:")) {
            return `Error: ${result.slice(6)}`;
        }
        return `Device '${device_name}' deleted from the topology.`;
    });

    async function _edit(js) {
        /** Send one canvas edit that reads itself back; the reply, or the error text. */
        const err = await _check_bridge();
        if (err) {
            return err;
        }
        const raw = await _bridge_send_and_wait(js, 8.0);
        if (raw === null || raw === undefined) {
            return "No response from PT.";
        }
        if (raw.startsWith("ERROR:")) {
            return `Error: ${raw.slice(6)}`;
        }
        let data;
        try {
            data = JSON.parse(raw);
        } catch (exc) {
            return `Unreadable reply from PT: ${exc.message}`;
        }
        if (!pyTruthy(data["ok"])) {
            const e = data["error"];
            const msg = (e !== null && e !== undefined
                && Object.prototype.hasOwnProperty.call(_EDIT_ERRORS, e)) ? _EDIT_ERRORS[e] : e;
            return `Error: ${pyStr(msg)}`;
        }
        delete data["ok"];
        return data;
    }

    registry.tool("pt_rename_device", async (args = {}) => {
        const { old_name, new_name } = args;
        const why = bad_device_name(new_name);
        if (pyTruthy(why)) {
            return `Error: new_name refused: ${why}.`;
        }
        if (old_name === new_name) {
            return `Device '${old_name}' already has that name — no changes.`;
        }
        const data = await _edit(rename_device_js(old_name, new_name));
        if (data === "Error: duplicate") {
            return (
                `Error: a device named '${new_name}' already exists. `
                + "Two devices with the same name make PT always resolve "
                + "to the same one, and the other becomes unreachable by name — "
                + "pick another name or rename the one that holds it first."
            );
        }
        if (typeof data === "string") {
            return data;
        }
        data["summary"] = (
            data["verified"]
                ? `✅ Device renamed: '${old_name}' → '${new_name}' (verified).`
                : `⚠ setName ran but the read-back does not match: new name present=`
                    + `${pyStr(data["new_present"])}, old name gone=${pyStr(data["old_absent"])}.`
        );
        return reply_json(data);
    });

    registry.tool("pt_move_device", async (args = {}) => {
        const { device_name, x, y } = args;
        const data = await _edit(move_device_js(device_name, x, y));
        if (typeof data === "string") {
            return data;
        }
        data["summary"] = (
            data["verified"]
                ? `✅ Device '${device_name}' moved to (${x}, ${y}) (verified).`
                : `⚠ Asked for (${x}, ${y}) but PT reads (${pyStr(data["x"])}, ${pyStr(data["y"])}).`
        );
        return reply_json(data);
    });

    registry.tool("pt_delete_link", async (args = {}) => {
        const { device_name, interface_name } = args;
        const data = await _edit(delete_link_js(device_name, interface_name));
        if (typeof data === "string") {
            return data;
        }
        const cable_raw = "cable_raw" in data ? data["cable_raw"] : null;
        delete data["cable_raw"];
        data["cable"] = cable_type_name(cable_raw);
        const peer = pyTruthy(data["peer"]) ? data["peer"] : {};
        const far = pyTruthy(peer) ? `${pyStr(peer["device"])}/${pyStr(peer["port"])}` : "the far end (unreadable)";
        data["summary"] = (
            data["verified"]
                ? `✅ Link ${device_name}/${interface_name} <-> ${far} deleted (verified on both ends).`
                : `⚠ deleteLink ran but the read-back is not clean: this port free=`
                    + `${pyStr(data["local_free"])}, ${far} free=${pyStr(data["peer_free"])}.`
        );
        return reply_json(data);
    });

    // ------------------------------------------------------------------
    // VALIDATED BUILDERS — pt_add_device, pt_add_link (MEJORA-01)
    // ------------------------------------------------------------------

    const _CABLE_ALIASES = {
        "crossover": "cross",
        "cross-over": "cross",
        "copper-crossover": "cross",
        "copper-straight": "straight",
        "straight-through": "straight",
        "rollover": "roll",
        "dce": "serial",
        "serial-dce": "serial",
    };

    registry.tool("pt_add_device", async (args = {}) => {
        const { name, model, x = 200, y = 200 } = args;
        const why = bad_device_name(name);
        if (pyTruthy(why)) {
            return `ERROR: Device name refused: ${why}.`;
        }

        const device_model = resolve_model(model);
        if (device_model === null || device_model === undefined) {
            return (
                `ERROR: Model '${model}' not found in catalog.\n`
                + `Use pt_list_devices to see available models.`
            );
        }

        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const js = (
            "try {" + WALK_JS
            + `  var N = ${pyJsonDumps(name.trim())};`
            + "  var dup = false;"
            + "  __eachDevice(function(d) { if (d.getName() === N) { dup = true; } });"
            + "  if (dup) {"
            + "    reportResult('ERROR:DUPLICATE:Device \\' + N + \\' already exists');"
            + "    throw 'dup';"
            + "  }"
            // The deploy's creation path (lwAddDevice, with its addDevice fallback),
            // then the IOS boot skip core.js's addDevice used to do.
            + `  ${add_device_call(name.trim(), device_model.pt_type, device_model.category, x, y)};`
            + "  var check = ipc.network().getDevice(N);"
            + "  if (check && typeof check.skipBoot === 'function') {"
            + "    var t = check.getType(); if (t === 0 || t === 1 || t === 16) { check.skipBoot(); }"
            + "  }"
            + "  if (check) {"
            + "    reportResult('OK:' + check.getName() + '|' + check.getModel());"
            + "  } else {"
            + "    reportResult('ERROR:Device was not created (unknown reason)');"
            + "  }"
            + "} catch(e) { if (e !== 'dup') reportResult('ERROR:' + e); }"
        );
        const result = await _bridge_send_and_wait(js, 10.0);
        if (result === null || result === undefined) {
            return _TIMEOUT_MSG;
        }
        if (result.startsWith("ERROR:DUPLICATE:")) {
            return result.slice(6);
        }
        if (result.startsWith("ERROR:")) {
            return `PT error: ${result.slice(6)}`;
        }
        return `Device '${name}' (${device_model.pt_type}) created at (${x}, ${y}).`;
    });

    registry.tool("pt_add_link", async (args = {}) => {
        const { device1, port1, device2, port2, cable_type = "" } = args;
        let resolved_cable;
        if (pyTruthy(cable_type)) {
            resolved_cable = _CABLE_ALIASES[cable_type.toLowerCase()] ?? cable_type.toLowerCase();
            if (!(resolved_cable in CABLE_TYPES)) {
                const valid = Object.keys(CABLE_TYPES)
                    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(", ");
                return (
                    `ERROR: Cable type '${cable_type}' is not valid.\n`
                    + `Valid types: ${valid}\n`
                    + `Common aliases: crossover→cross, rollover→roll`
                );
            }
        } else {
            resolved_cable = "";
        }

        const err = await _check_bridge();
        if (err) {
            return err;
        }

        // Each name reaches JS once, through json.dumps, as a variable; the
        // messages below concatenate the variables, never the raw text.
        const names = (
            `var D1=${pyJsonDumps(device1)},P1=${pyJsonDumps(port1)},`
            + `D2=${pyJsonDumps(device2)},P2=${pyJsonDumps(port2)};`
        );
        const js = (
            "try {" + names
            + "  var d1 = ipc.network().getDevice(D1);"
            + "  var d2 = ipc.network().getDevice(D2);"
            + "  if (!d1) { reportResult('ERROR:Device \\' + D1 + \\' not found'); throw 'stop'; }"
            + "  if (!d2) { reportResult('ERROR:Device \\' + D2 + \\' not found'); throw 'stop'; }"
            + "  var p1 = d1.getPort(P1);"
            + "  var p2 = d2.getPort(P2);"
            + "  if (!p1) { reportResult('ERROR:Port \\' + P1 + \\' not found on \\' + D1 + \\''); throw 'stop'; }"
            + "  if (!p2) { reportResult('ERROR:Port \\' + P2 + \\' not found on \\' + D2 + \\''); throw 'stop'; }"
            + "  if (p1.getLink() != null) {"
            + "    reportResult('ERROR:Port \\' + P1 + \\' on \\' + D1 + \\' already has a link'); throw 'stop';"
            + "  }"
            + "  if (p2.getLink() != null) {"
            + "    reportResult('ERROR:Port \\' + P2 + \\' on \\' + D2 + \\' already has a link'); throw 'stop';"
            + "  }"
            // getModel() and NOT getClassName(): PT's class does not tell a
            // switch from a router (a 3560 says "Router" because it is multilayer, and
            // a 2960 says "CiscoDevice"), so no "switch" category ever reached
            // CABLE_RULES and a router↔switch link came out crossed.
            + "  reportResult('PRE_OK:' + d1.getModel() + '|' + d2.getModel());"
            + "} catch(e) { if (e !== 'stop') reportResult('ERROR:' + e); }"
        );
        const pre_result = await _bridge_send_and_wait(js, 10.0);
        if (pre_result === null || pre_result === undefined) {
            return _TIMEOUT_MSG;
        }
        if (pre_result.startsWith("ERROR:")) {
            return pre_result;
        }
        if (!pre_result.startsWith("PRE_OK:")) {
            return `Unexpected response: ${pre_result}`;
        }

        if (!pyTruthy(resolved_cable)) {
            const parts = pre_result.slice(7).split("|");
            const model1 = parts.length > 0 ? parts[0].trim() : "";
            const model2 = parts.length > 1 ? parts[1].trim() : "";
            resolved_cable = infer_cable(
                category_of_model(model1), category_of_model(model2)
            );
        }

        const js_link = (
            "try {" + names
            + `  ${add_link_call(device1, port1, device2, port2, resolved_cable)};`
            + "  var pCheck = ipc.network().getDevice(D1).getPort(P1);"
            + "  if (pCheck && pCheck.getLink() != null) {"
            + "    reportResult('OK:link created');"
            + "  } else {"
            + "    reportResult('ERROR:addLink returned but link not found on ' + P1);"
            + "  }"
            + "} catch(e) { reportResult('ERROR:' + e); }"
        );
        const link_result = await _bridge_send_and_wait(js_link, 10.0);
        if (link_result === null || link_result === undefined) {
            return "No response after addLink (timeout).";
        }
        if (link_result.startsWith("ERROR:")) {
            return `Link creation failed: ${link_result.slice(6)}`;
        }
        return `Link created: ${device1}/${port1} <--[${resolved_cable}]--> ${device2}/${port2}`;
    });

    // ------------------------------------------------------------------
    // RAW JS EXECUTION
    // ------------------------------------------------------------------

    registry.tool("pt_set_port", async (args = {}) => {
        const {
            device, interface: iface,
            bandwidth = 0,
            bandwidth_auto = -1,
            full_duplex = -1,
            duplex_auto = -1,
            description = "",
            mac_address = "",
            power = -1,
            zone_member = "",
            proxy_arp = -1,
            ike = -1,
        } = args;
        const bad = [["device", device], ["interface", iface],
                     ["description", description], ["mac_address", mac_address],
                     ["zone_member", zone_member]]
            .filter(([, v]) => has_control_chars(v)).map(([k]) => k);
        if (bad.length) {
            return `ERROR: ${bad.join(", ")} contains a line break; use single-line values.`;
        }
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const parts = [
            'var d=ipc.network().getDevice(' + pyJsonDumps(device) + ');',
            'if(!d){reportResult(JSON.stringify({success:false,error:"device not found: "+' + pyJsonDumps(device) + '}));return;}',
            'var p=d.getPort(' + pyJsonDumps(iface) + ');',
            'if(!p){reportResult(JSON.stringify({success:false,error:"port not found: "+' + pyJsonDumps(iface) + '}));return;}',
            'var applied=[];',
        ];

        if (pyTruthy(bandwidth) && bandwidth > 0) {
            parts.push(
                `if(typeof p.setBandwidth==="function"){p.setBandwidth(${Math.trunc(bandwidth)});applied.push("bandwidth=${Math.trunc(bandwidth)}");}`
            );
        }
        if (bandwidth_auto === 0 || bandwidth_auto === 1) {
            const v = bandwidth_auto === 1 ? "true" : "false";
            parts.push(
                `if(typeof p.setBandwidthAutoNegotiate==="function"){p.setBandwidthAutoNegotiate(${v});applied.push("bandwidth_auto=${v}");}`
            );
        }
        if (full_duplex === 0 || full_duplex === 1) {
            const v = full_duplex === 1 ? "true" : "false";
            parts.push(
                `if(typeof p.setFullDuplex==="function"){p.setFullDuplex(${v});applied.push("full_duplex=${v}");}`
            );
        }
        if (duplex_auto === 0 || duplex_auto === 1) {
            const v = duplex_auto === 1 ? "true" : "false";
            parts.push(
                `if(typeof p.setDuplexAutoNegotiate==="function"){p.setDuplexAutoNegotiate(${v});applied.push("duplex_auto=${v}");}`
            );
        }
        if (pyTruthy(description)) {
            parts.push(
                `if(typeof p.setDescription==="function"){p.setDescription(${pyJsonDumps(description)});applied.push("description");}`
            );
        }
        if (pyTruthy(mac_address)) {
            parts.push(
                `if(typeof p.setMacAddress==="function"){p.setMacAddress(${pyJsonDumps(mac_address)});applied.push("mac");}`
            );
        }
        if (power === 0 || power === 1) {
            const v = power === 1 ? "true" : "false";
            parts.push(
                `if(typeof p.setPower==="function"){p.setPower(${v});applied.push("power=${v}");}`
            );
        }

        // Zone-Based Firewall / Proxy ARP / IKE: they only exist on router
        // ports, so the typeof is not over-defensive — on a switch or a
        // host these setters are missing and calling them would open a modal.
        if (pyTruthy(zone_member)) {
            parts.push(
                `if(typeof p.setZoneMemberName==="function"){p.setZoneMemberName(${pyJsonDumps(zone_member)});applied.push("zone_member");}`
            );
        }
        if (proxy_arp === 0 || proxy_arp === 1) {
            const v = proxy_arp === 1 ? "true" : "false";
            parts.push(
                `if(typeof p.setProxyArpEnabled==="function"){p.setProxyArpEnabled(${v});applied.push("proxy_arp=${v}");}`
            );
        }
        if (ike === 0 || ike === 1) {
            const v = ike === 1 ? "true" : "false";
            parts.push(
                `if(typeof p.setIkeEnabled==="function"){p.setIkeEnabled(${v});applied.push("ike=${v}");}`
            );
        }

        parts.push('reportResult(JSON.stringify({success:true,applied:applied}));');

        // IIFE so early `return`s work in PT's Script Engine.
        const js = '(function(){' + parts.join("") + '})()';

        const result = await _bridge_send_and_wait(js, 8.0);
        if (result === null || result === undefined) {
            return "No answer from PT.";
        }
        try {
            const data = JSON.parse(result);
            if (pyTruthy(data["success"])) {
                const applied = data["applied"] ?? [];
                if (!applied.length) {
                    return (
                        `Nothing applied on ${device}/${iface}: `
                        + "no attributes were passed or no setXxx is available on this model."
                    );
                }
                return `Applied on ${device}/${iface}: ` + applied.join(", ");
            }
            return `Error: ${"error" in data ? pyStr(data["error"]) : "unknown"}`;
        } catch (exc) {
            return `Unexpected reply: ${result}`;
        }
    });

    registry.tool("pt_send_raw", async (args = {}) => {
        const { js_code, wait_result = false } = args;
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        if (wait_result) {
            const result = await _bridge_send_and_wait(js_code, 10.0);
            if (result === null || result === undefined) {
                return "No answer (timeout). Make sure the code calls reportResult(...).";
            }
            return result;
        } else {
            if (await _channel_send(_js_guard(js_code))) {
                return "Command sent to PT.";
            }
            return "Error sending the command to the bridge.";
        }
    });
}
