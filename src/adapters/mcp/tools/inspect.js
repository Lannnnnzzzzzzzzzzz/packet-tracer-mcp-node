// Live-state tools: plan-vs-PT diff, health check, port inspection, power on/off.

import { TopologyPlan } from "../../../domain/models/plans.js";
import { diff as topology_diff, health_check } from "../../../domain/services/topology_diff.js";
import { nat_mode_label, summarize_ports } from "../../../domain/services/port_inspect.js";
import { cable_type_name } from "../../../infrastructure/catalog/cables.js";
import { PORT_LINK_JS } from "../../../infrastructure/generator/topology_js.js";
import { WALK_JS } from "../../../infrastructure/generator/walk_js.js";
import { TIMEOUT_MSG } from "../bridge_context.js";
import { pyJsonDumps } from "../../../shared/pycompat.js";
import { reply_json } from "../../../shared/utils.js";

// Python `TopologyPlan.model_validate_json(text)`.
function _plan_validate_json(text) {
    if (typeof TopologyPlan.model_validate_json === "function") return TopologyPlan.model_validate_json(text);
    if (typeof TopologyPlan.modelValidateJson === "function") return TopologyPlan.modelValidateJson(text);
    if (typeof TopologyPlan.fromJson === "function") return TopologyPlan.fromJson(text);
    return new TopologyPlan(JSON.parse(text));
}


export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _TIMEOUT_MSG = TIMEOUT_MSG;
    const _bridge_send_and_wait = async (js, timeout) => await ctx.send_and_wait(js, timeout);
    const _check_bridge = async () => await ctx.check_bridge();
    const _live_devices = async () => await ctx.live_devices();

    registry.tool("pt_diff", async (args) => {
        const plan_json = args.plan_json;
        let plan;
        try {
            plan = _plan_validate_json(plan_json);
        } catch (exc) {
            const msg = exc && exc.message !== undefined ? exc.message : String(exc);
            return pyJsonDumps({"error": `invalid plan_json: ${msg}`}, {ensureAscii: false});
        }
        const err = await _check_bridge();
        if (err) {
            return err;
        }
        const live = await _live_devices();
        const result = topology_diff(plan, live);
        result["summary"] = (
            result["in_sync"]
            ? "✅ Plan and PT in sync."
            : `⚠ ${result['missing_devices'].length} missing, `
                 + `${result['extra_devices'].length} extra(s), `
                 + `${result['ip_mismatches'].length} IP mismatch(es).`
        );
        return reply_json(result);
    });

    registry.tool("pt_health_check", async (args) => {
        const err = await _check_bridge();
        if (err) {
            return err;
        }
        const live = await ctx.read_live_devices();
        if (live === null || live === undefined) {
            // A failed read used to come back as [] and pass for a healthy topology.
            return reply_json({"healthy": null, "error": "read_failed", "summary":
                               "❌ Could not read the canvas (no answer or PT error): "
                               + "health UNKNOWN. Check pt_bridge_status and retry."});
        }
        if (!live.length) {
            return reply_json({"healthy": true, "empty": true,
                               "summary": "The canvas is empty: nothing to check."});
        }
        const result = health_check(live);
        result["summary"] = (
            result["healthy"]
            ? "✅ Healthy topology."
            : `⚠ ${result['down_links'].length} link(s) down, `
                 + `${result['duplicate_ips'].length} duplicate IP(s).`
        );
        // "healthy" only covers down links and duplicates: a host left without an
        // address must not hide behind a green summary.
        if (result["cabled_without_ip"] && result["cabled_without_ip"].length) {
            result["summary"] += (
                ` ⚠ ${result['cabled_without_ip'].length} cabled port(s) without an IP `
                + "(DHCP pending?)."
            );
        }
        return reply_json(result);
    });

    // ------------------------------------------------------------------
    // PORT INSPECTION — physical and logical state read from the device
    // ------------------------------------------------------------------

    function _inspect_ports_js(device) {
        /** Per-port reader. Empty `device` = all.
         *
         * Each getter sits behind a typeof: Port's surface changes by
         * model (a PC-PT has no getNatMode or getAclInID) and a call to a
         * missing method throws and opens a modal that freezes the bridge.
         */
        const want = pyJsonDumps(device.trim());
        return (
            "try {"
            + PORT_LINK_JS + WALK_JS +
            `  var __want = ${want};`
            + "  var __out = [];"
            + "  __eachDevice(function(__d) {"
            + "      var __dn = __d.getName();"
            + "      if (__want && __dn !== __want) return;"
            + "      var __ports = [];"
            + "      __eachPort(__d, function(__p) {"
            + "          __ports.push({"
            + "            name: __p.getName(),"
            + "            up: !!__p.isPortUp(),"
            + "            protocol_up: (typeof __p.isProtocolUp === 'function') ? !!__p.isProtocolUp() : null,"
            + "            linked: !!__p.getLink(),"
            + "            link: __plink(String(__dn), __p),"
            + "            ip: __p.getIpAddress(),"
            + "            mask: __p.getSubnetMask(),"
            + "            mac: (typeof __p.getMacAddress === 'function') ? __p.getMacAddress() : null,"
            + "            description: (typeof __p.getDescription === 'function') ? __p.getDescription() : '',"
            + "            duplex_full: (typeof __p.isFullDuplex === 'function') ? !!__p.isFullDuplex() : null,"
            + "            bandwidth_kbps: (typeof __p.getBandwidth === 'function') ? __p.getBandwidth() : null,"
            + "            mtu: (typeof __p.getMtu === 'function') ? __p.getMtu() : null,"
            + "            delay: (typeof __p.getDelay === 'function') ? __p.getDelay() : null,"
            + "            cdp: (typeof __p.isCdpEnable === 'function') ? !!__p.isCdpEnable() : null,"
            + "            dhcp_client: (typeof __p.isDhcpClientOn === 'function') ? !!__p.isDhcpClientOn() : null,"
            + "            wireless: (typeof __p.isWirelessPort === 'function') ? !!__p.isWirelessPort() : null,"
            + "            nat_mode_raw: (typeof __p.getNatMode === 'function') ? __p.getNatMode() : null,"
            + "            acl_in: (typeof __p.getAclInID === 'function') ? __p.getAclInID() : '',"
            + "            acl_out: (typeof __p.getAclOutID === 'function') ? __p.getAclOutID() : ''"
            + "          });"
            + "      });"
            + "      __out.push({"
            + "        name: __dn,"
            + "        model: (typeof __d.getModel === 'function') ? __d.getModel() : '',"
            + "        ports: __ports"
            + "      });"
            + "  });"
            + "  reportResult(JSON.stringify({ devices: __out }));"
            + "} catch (__e) { reportResult('ERROR:' + __e); }"
        );
    }

    registry.tool("pt_inspect_ports", async (args) => {
        const device = args.device !== undefined ? args.device : "";
        const only_linked = args.only_linked !== undefined ? args.only_linked : false;
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const raw = await _bridge_send_and_wait(_inspect_ports_js(device), 15.0);
        if (raw === null || raw === undefined) {
            return _TIMEOUT_MSG;
        }
        if (raw.startsWith("ERROR:")) {
            return `PT error: ${raw}`;
        }
        let devices;
        try {
            const parsed = JSON.parse(raw);
            devices = parsed["devices"] !== undefined && parsed["devices"] !== null ? parsed["devices"] : [];
        } catch (exc) {
            return `Unreadable reply from PT: ${exc.message !== undefined ? exc.message : exc}`;
        }

        const wanted = device.trim();
        if (wanted && !devices.length) {
            return (
                `'${wanted}' does not exist in the active topology. `
                + "Use pt_query_topology to see the real names."
            );
        }

        for (const dev of devices) {
            let ports = dev["ports"] !== undefined && dev["ports"] !== null ? dev["ports"] : [];
            if (only_linked) {
                ports = ports.filter((p) => p["linked"]);
            }
            for (const port of ports) {
                const nat_raw = "nat_mode_raw" in port ? port["nat_mode_raw"] : null;
                delete port["nat_mode_raw"];
                port["nat_mode"] = nat_mode_label(nat_raw);
                const link = "link" in port ? port["link"] : null;
                delete port["link"];
                if (link !== null && typeof link === "object" && !Array.isArray(link)) {
                    port["cable"] = cable_type_name(link["cable_raw"] !== undefined ? link["cable_raw"] : null);
                    port["peer"] = (link["peer_device"] ? `${link['peer_device']}:${link['peer_port']}` : null);
                }
            }
            dev["ports"] = ports;
        }

        const result = summarize_ports(devices);
        result["devices"] = devices;
        const anomalies = result["anomalies"];
        result["summary"] = (
            !anomalies.length
            ? `✅ ${result['ports_up']}/${result['ports_total']} port(s) up, `
              + `${result['ports_linked']} cabled, no anomalies.`
            : `⚠ ${anomalies.length} anomaly(ies) in ${result['ports_total']} port(s).`
        );
        return reply_json(result);
    });

    // ------------------------------------------------------------------
    // POWER ON / OFF of devices
    // ------------------------------------------------------------------

    registry.tool("pt_device_power", async (args) => {
        const device = args.device;
        const on = args.on !== undefined ? args.on : true;
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const name = pyJsonDumps(device.trim());
        const want = on ? "true" : "false";
        const js = (
            "try {"
            + `  var __d = ipc.network().getDevice(${name});`
            + "  if (!__d) { reportResult(JSON.stringify({ found: false })); }"
            + "  else if (typeof __d.setPower !== 'function' || typeof __d.getPower !== 'function') {"
            + "    reportResult(JSON.stringify({ found: true, supported: false }));"
            + "  } else {"
            + "    var __before = !!__d.getPower();"
            + `    __d.setPower(${want});`
            + `    if (${want} && typeof __d.skipBoot === 'function') { __d.skipBoot(); }`
            + "    reportResult(JSON.stringify({"
            + "      found: true, supported: true,"
            + "      before: __before, after: !!__d.getPower(),"
            + "      booting: (typeof __d.isBooting === 'function') ? !!__d.isBooting() : null"
            + "    }));"
            + "  }"
            + "} catch (__e) { reportResult('ERROR:' + __e); }"
        );

        const raw = await _bridge_send_and_wait(js, 15.0);
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

        if (!data["found"]) {
            return (
                `'${device}' does not exist in the active topology. `
                + "Use pt_query_topology to see the real names."
            );
        }
        if (!data["supported"]) {
            // No model without setPower/getPower was seen in PT 9.0.0.0810
            // (not even PCs), but the surface varies by build and a
            // missing method throws and opens a modal that freezes the bridge.
            return `'${device}' does not expose power control in this PT build.`;
        }

        const verb = on ? "powered on" : "powered off";
        if (data["after"] === on) {
            data["summary"] = (
                data["before"] !== on
                ? `✅ '${device}' ${verb}.`
                : `'${device}' was already ${verb}; no changes.`
            );
        } else {
            data["summary"] = (
                `⚠ Asked for ${verb} but PT reports power=${data['after'] ? "True" : "False"}. `
                + "The model may not support the change."
            );
        }
        return reply_json(data);
    });
}
