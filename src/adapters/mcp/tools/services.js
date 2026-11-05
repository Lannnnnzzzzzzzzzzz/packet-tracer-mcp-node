// Service tools: NetFlow, Server-PT DHCP pools, QoS read-back.

import { NetflowExporter } from "../../../domain/models/netflow.js";
import { ErrorCode, PlanError } from "../../../domain/models/errors.js";
import { validate_netflow, validate_netflow_against_topology } from "../../../domain/rules/netflow_rules.js";
import { DEFAULT_SERVER_POOL, DhcpServerPool } from "../../../domain/models/dhcp_server.js";
import { qos_policy_maps } from "../../../domain/services/qos.js";
import { has_control_chars } from "../../../domain/rules/text_rules.js";
import {
    resolve_range,
    validate_dhcp_server,
    validate_dhcp_server_against_topology,
} from "../../../domain/rules/dhcp_server_rules.js";
import { TIMEOUT_MSG } from "../bridge_context.js";
import { server_dhcp_js } from "../../../infrastructure/generator/service_js.js";
import { pyJsonDumps, pyStr, pyTruthy } from "../../../shared/pycompat.js";
import { reply_json } from "../../../shared/utils.js";


export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _TIMEOUT_MSG = TIMEOUT_MSG;
    const _pick_channel = async () => await ctx.pick_channel();
    const _bridge_send_and_wait = async (js, timeout) => await ctx.send_and_wait(js, timeout);
    const _check_bridge = async () => await ctx.check_bridge();
    const _live_devices = async () => await ctx.live_devices();

    // ------------------------------------------------------------------
    // NETFLOW — configured through the native API, not CLI
    // ------------------------------------------------------------------

    registry.tool("pt_apply_netflow", async (args) => {
        const device = args.device;
        const name = args.name;
        const destination_ip = args.destination_ip !== undefined ? args.destination_ip : "";
        const udp_port = args.udp_port !== undefined ? args.udp_port : 2055;
        const version = args.version !== undefined ? args.version : 9;
        const source_port = args.source_port !== undefined ? args.source_port : "";
        const monitors = args.monitors !== undefined ? args.monitors : null;
        const remove = args.remove !== undefined ? args.remove : false;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const cfg = new NetflowExporter({
            device: device, name: name, destination_ip: destination_ip.trim(),
            udp_port: udp_port, version: version, source_port: source_port.trim(),
            monitors: monitors || [],
        });

        const res = validate_netflow(cfg);
        let errors = [...res.errors];
        let warnings = [...res.warnings];

        const bridge_ok = (await _pick_channel()) !== "";
        if (bridge_ok) {
            try {
                const topo = validate_netflow_against_topology(cfg, await _live_devices());
                errors.push(...topo.errors);
                warnings.push(...topo.warnings);
            } catch (exc) {
                warnings.push(new PlanError({
                    code: ErrorCode.VALIDATION_ERROR, device: cfg.device,
                    message: `Could not validate against PT: ${exc && exc.message !== undefined ? exc.message : exc}`,
                    suggestion: "Check the bridge with pt_bridge_status.",
                }));
            }
        }

        const dev = pyJsonDumps(cfg.device);
        const exporter = pyJsonDumps(cfg.name);
        let body;
        if (remove) {
            body = (
                `    __m.removeNFExporter(${exporter});`
                + "    reportResult(JSON.stringify({ found: true, supported: true,"
                + "      removed: true, exporters: __m.getNFExporterCount() }));"
            );
        } else {
            const sets = [`      __e.setExporterVersion(${Math.trunc(Number(cfg.version))});`];
            if (pyTruthy(cfg.destination_ip)) {
                sets.push(`      __e.setDestinationAddr(${pyJsonDumps(cfg.destination_ip)});`);
            }
            sets.push(`      __e.setDestinationUdpPort(${Math.trunc(Number(cfg.udp_port))});`);
            if (pyTruthy(cfg.source_port)) {
                sets.push(`      __e.setSrcPort(${pyJsonDumps(cfg.source_port)});`);
            }
            for (const monitor of cfg.monitors) {
                sets.push(`      __e.addMonitor(${pyJsonDumps(monitor)});`);
            }
            body = (
                `    var __e = __m.getNFExporterByName(${exporter});`
                + "    var __created = false;"
                + `    if (!__e) { __e = __m.createNFExporter(${exporter}); __created = true; }`
                + `    if (!__e) { reportResult(JSON.stringify({ found: true, supported: true,`
                + "      error: 'could not create the exporter' })); } else {"
                + sets.join("") +
                "      reportResult(JSON.stringify({ found: true, supported: true,"
                + "        created: __created, name: __e.getExporterName(),"
                + "        version: __e.getExporterVersion(),"
                + "        destination: String(__e.getDestinationAddr()),"
                + "        udp_port: __e.getDestinationUdpPort(),"
                + "        fully_configured: !!__e.isFullyConfigured(),"
                + "        exporters: __m.getNFExporterCount() }));"
                + "    }"
            );
        }

        const js = (
            "try {"
            + `  var __d = ipc.network().getDevice(${dev});`
            + "  if (!__d) { reportResult(JSON.stringify({ found: false })); }"
            + "  else if (typeof __d.getNetflowExporterManager !== 'function') {"
            + "    reportResult(JSON.stringify({ found: true, supported: false }));"
            + "  } else {"
            + "    var __m = __d.getNetflowExporterManager();"
            + body +
            "  }"
            + "} catch (__e2) { reportResult('ERROR:' + __e2); }"
        );

        const payload = {
            "valid": !errors.length,
            "errors": errors.map((e) => e.to_dict()),
            "warnings": warnings.map((w) => w.to_dict()),
            "js_payload": js,
            "dry_run": dry_run,
            "sent": false,
        };

        if (errors.length) {
            payload["summary"] = `❌ NetFlow: ${errors.length} error(s); nothing was sent.`;
            return reply_json(payload);
        }
        if (dry_run) {
            payload["summary"] = "✅ NetFlow valid. dry_run mode — NOT sent to the bridge.";
            return reply_json(payload);
        }

        const err = await _check_bridge();
        if (err) {
            return err;
        }

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
            return `'${device}' does not expose NetFlow (PT's switches and hosts don't have it).`;
        }

        Object.assign(payload, data);
        payload["sent"] = true;
        if (remove) {
            payload["summary"] = `✅ Exporter '${name}' removed from ${device}.`;
        } else if (data["fully_configured"]) {
            payload["summary"] = (
                `✅ '${name}' ${data['created'] ? 'created' : 'updated'} on ${device} `
                + `→ ${pyStr(data['destination'] !== undefined && data['destination'] !== null ? data['destination'] : null)}:${pyStr(data['udp_port'] !== undefined && data['udp_port'] !== null ? data['udp_port'] : null)} (v${pyStr(data['version'] !== undefined && data['version'] !== null ? data['version'] : null)}).`
            );
        } else {
            payload["summary"] = (
                `⚠ '${name}' exists on ${device} but PT reports it incomplete: `
                + "without a destination it exports no flows."
            );
        }
        return reply_json(payload);
    });

    // ------------------------------------------------------------------
    // DHCP ON A SERVER-PT — native API, a Server-PT has no CLI (issue #23)
    // ------------------------------------------------------------------

    registry.tool("pt_configure_dhcp_server", async (args) => {
        const device = args.device;
        const network = args.network !== undefined ? args.network : "";
        const mask = args.mask !== undefined ? args.mask : "255.255.255.0";
        const gateway = args.gateway !== undefined ? args.gateway : "";
        const dns = args.dns !== undefined ? args.dns : "";
        const start_ip = args.start_ip !== undefined ? args.start_ip : "";
        const max_users = args.max_users !== undefined ? args.max_users : 0;
        const pool_name = args.pool_name !== undefined ? args.pool_name : DEFAULT_SERVER_POOL;
        const port = args.port !== undefined ? args.port : "FastEthernet0";
        const enabled = args.enabled !== undefined ? args.enabled : true;
        const drop_factory_pool = args.drop_factory_pool !== undefined ? args.drop_factory_pool : true;
        const remove = args.remove !== undefined ? args.remove : false;
        const dry_run = args.dry_run !== undefined ? args.dry_run : false;
        const cfg = new DhcpServerPool({
            device: device.trim(), pool_name: pool_name.trim(), port: port.trim(),
            network: network.trim(), mask: mask.trim(), gateway: gateway.trim(),
            dns: dns.trim(), start_ip: start_ip.trim(), max_users: max_users,
        });
        const read_only = !pyTruthy(cfg.network) && !remove;

        let errors = [];
        let warnings = [];
        if (!read_only && !remove) {
            const res = validate_dhcp_server(cfg);
            errors.push(...res.errors);
            warnings.push(...res.warnings);
        } else if (remove && (!pyTruthy(cfg.pool_name) || has_control_chars(cfg.pool_name))) {
            errors.push(new PlanError({
                code: ErrorCode.DHCP_INVALID_POOL_NAME, device: cfg.device,
                message: "Invalid pool name to delete.",
                suggestion: "Pass the exact name; read it first without network.",
            }));
        }
        if (has_control_chars(cfg.device) || has_control_chars(cfg.port)) {
            errors.push(new PlanError({
                code: ErrorCode.DHCP_SERVER_DEVICE_NOT_FOUND, device: cfg.device,
                message: "The device or port name contains line breaks.",
                suggestion: "Use the exact names from pt_query_topology.",
            }));
        }

        if (!errors.length && (await _pick_channel()) !== "") {
            try {
                const topo = validate_dhcp_server_against_topology(cfg, await _live_devices());
                errors.push(...topo.errors);
                if (!read_only && !remove) {
                    warnings.push(...topo.warnings);
                }
            } catch (exc) {
                warnings.push(new PlanError({
                    code: ErrorCode.VALIDATION_ERROR, device: cfg.device,
                    message: `Could not validate against PT: ${exc && exc.message !== undefined ? exc.message : exc}`,
                    suggestion: "Check the bridge with pt_bridge_status.",
                }));
            }
        }

        let expected = {};
        // The JS is server_dhcp_js, the same backend pt_server_dhcp uses: one
        // implementation of the measured DHCP API for both tools.
        const js_kwargs = {"port": cfg.port, "enable": null};
        if (remove) {
            js_kwargs["remove_pool"] = cfg.pool_name;
        } else if (!read_only && !errors.length) {
            const [start, users] = resolve_range(cfg);
            expected = {
                "network": cfg.network, "mask": cfg.mask, "start": start,
                "max_users": users,
            };
            if (pyTruthy(cfg.gateway)) {
                expected["gateway"] = cfg.gateway;
            }
            if (pyTruthy(cfg.dns)) {
                expected["dns"] = cfg.dns;
            }
            Object.assign(js_kwargs, {
                pool: cfg.pool_name, network: cfg.network, mask: cfg.mask,
                gateway: cfg.gateway, dns: cfg.dns, start_ip: start, max_users: users,
                enable: enabled, drop_factory_pool: drop_factory_pool,
            });
        }
        const js = server_dhcp_js(cfg.device, js_kwargs);

        const payload = {
            "valid": !errors.length,
            "errors": errors.map((e) => e.to_dict()),
            "warnings": warnings.map((w) => w.to_dict()),
            "mode": read_only ? "read" : (remove ? "remove" : "configure"),
            "js_payload": js,
            "dry_run": dry_run,
            "sent": false,
        };
        if (errors.length) {
            payload["summary"] = `❌ DHCP server: ${errors.length} error(s); nothing was sent.`;
            return reply_json(payload);
        }
        if (dry_run) {
            payload["summary"] = "✅ Pool is valid. dry_run mode — NOT sent to the bridge.";
            return reply_json(payload);
        }

        const err = await _check_bridge();
        if (err) {
            return err;
        }

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

        if (data["ok"] === false) {
            const _by_error = {
                "device_not_found": (`'${device}' does not exist in the active topology. `
                                     + "Use pt_query_topology to see the real names."),
                "no_DhcpServerMain": (`'${device}' has no Server-PT DHCP server. If it is a `
                                      + "router, DHCP goes through the CLI (`ip dhcp pool`) or "
                                      + "the plan with dhcp=True."),
                "port_not_found": `'${device}' has no DHCP server on port '${port}'.`,
            };
            return _by_error[data["error"]] !== undefined
                ? _by_error[data["error"]]
                : `PT error: ${pyStr(data['error'] !== undefined && data['error'] !== null ? data['error'] : null)}`;
        }

        Object.assign(payload, data);
        payload["sent"] = true;
        // It already ran: the JS (~1.5 KB) only clutters the context. dry_run keeps it.
        delete payload["js_payload"];
        const pools = {};
        for (const p of (data["pools"] !== undefined && data["pools"] !== null ? data["pools"] : [])) pools[p["name"]] = p;
        const state = data["enabled"] ? "ON" : "OFF";

        if (read_only) {
            payload["summary"] = (
                `Read only: ${Object.keys(pools).length} pool(s) on ${device}, service ${state}.`
            );
        } else if (remove) {
            const gone = !(cfg.pool_name in pools);
            payload["summary"] = (
                gone ? `✅ Pool '${cfg.pool_name}' deleted from ${device}.`
                : `⚠ PT did not delete '${cfg.pool_name}': it is still in the pool list.`
            );
        } else if (pyTruthy(data["error"])) {
            payload["summary"] = `❌ ${data['error']}.`;
        } else {
            const got = pools[cfg.pool_name] !== undefined ? pools[cfg.pool_name] : {};
            const mismatches = [];
            for (const [k, v] of Object.entries(expected)) {
                if (String(got[k] !== undefined && got[k] !== null ? got[k] : "None") !== String(v)) {
                    mismatches.push(`${k}: requested ${v}, got ${got[k] !== undefined && got[k] !== null ? got[k] : "None"}`);
                }
            }
            if (Boolean(data["enabled"]) !== enabled) {
                mismatches.push(`service: requested ${enabled ? 'ON' : 'OFF'}, got ${state}`);
            }
            payload["mismatches"] = mismatches;
            if (mismatches.length) {
                payload["summary"] = (
                    `⚠ '${cfg.pool_name}' applied on ${device} but the read-back does not `
                    + `match: ${mismatches.join("; ")}.`
                );
            } else {
                payload["summary"] = (
                    `✅ '${cfg.pool_name}' ${data['created'] ? 'created' : 'updated'} `
                    + `on ${device}: ${pyStr(got['start'] !== undefined && got['start'] !== null ? got['start'] : null)}-${pyStr(got['end'] !== undefined && got['end'] !== null ? got['end'] : null)} `
                    + `(${pyStr(got['max_users'] !== undefined && got['max_users'] !== null ? got['max_users'] : null)} IPs), gw ${pyStr(got['gateway'] !== undefined && got['gateway'] !== null ? got['gateway'] : null)}, service ${state}.`
                    + (data["dropped_factory_pool"] ? " The unconfigured factory serverPool was deleted." : "")
                );
            }
        }
        return reply_json(payload);
    });

    // ------------------------------------------------------------------
    // QoS — READ ONLY: PT's API does not allow creating class/policy-maps
    // ------------------------------------------------------------------

    registry.tool("pt_read_qos", async (args) => {
        const device = args.device;
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const dev = pyJsonDumps(device.trim());
        // __call: a guarded getter (missing or throwing -> null). PolicyMap.toString()
        // THROWS on PT 9 (measured), so it is never called; the CLI comes from the
        // running-config instead.
        const js = (
            "try {"
            + `  var __d = ipc.network().getDevice(${dev});`
            + "  function __call(o, m) { try { return (o && typeof o[m] === 'function') ? o[m]() : null; }"
            + "    catch (__x) { return null; } }"
            + "  if (!__d) { reportResult(JSON.stringify({ found: false })); }"
            + "  else if (typeof __d.getClassMapManager !== 'function') {"
            + "    reportResult(JSON.stringify({ found: true, supported: false }));"
            + "  } else {"
            + "    var __cm = __d.getClassMapManager();"
            + "    var __pm = (typeof __d.getPolicyMapManager === 'function')"
            + "      ? __d.getPolicyMapManager() : null;"
            + "    var __cs = [], __ps = [];"
            + "    var __cn = __cm.getClassMapCount();"
            + "    for (var __i = 0; __i < __cn; __i++) {"
            + "      try {"
            + "        var __c = __cm.getClassMapAt(__i);"
            + "        if (!__c) continue;"
            + "        __cs.push({ name: __c.getMapName(), description: __call(__c, 'getDescription'),"
            + "          match: __call(__c, 'getMatchTypeString'), statements: __call(__c, 'getStatementCnt'),"
            + "          is_default: !!__call(__c, 'isClassDefault'), cli: __call(__c, 'toString') });"
            + "      } catch (__ce) {}"
            + "    }"
            + "    var __pn = 0;"
            + "    try { __pn = __pm ? __pm.getPolicyMapCount() : 0; } catch (__x) {}"
            + "    for (var __j = 0; __j < __pn; __j++) {"
            + "      try {"
            + "        var __p = __pm.getPolicyMapAt(__j);"
            + "        if (!__p) continue;"
            + "        var __name = String(__p.getMapName());"
            + "        if (__name.indexOf('default-policy-map') >= 0) continue;"
            + "        var __k = 0, __cls = [];"
            + "        try { __k = __p.getClassCnt(); } catch (__x) {}"
            + "        for (var __q = 0; __q < __k; __q++) {"
            + "          try {"
            + "            var __pc = __p.getClassAt(__q);"
            + "            if (!__pc) continue;"
            + "            __cls.push({ priority_kbps: __call(__pc, 'getPriority'),"
            + "              bandwidth_configured: !!__call(__pc, 'isBandwidthConfigured'),"
            + "              bandwidth: __call(__pc, 'getBandwidth'),"
            + "              fair_queue: !!__call(__pc, 'isFairQueueConfigured'),"
            + "              class_default: !!__call(__pc, 'isClassDefault') });"
            + "          } catch (__x) {}"
            + "        }"
            + "        __ps.push({ name: __name, class_count: __k,"
            + "          priority: !!__call(__p, 'isPriorityConfigured'),"
            + "          fair_queue: !!__call(__p, 'isFairQueueConfigured'),"
            + "          bandwidth: __call(__p, 'isBandwidthConfigured'),"
            + "          shaping: __call(__p, 'isShapeConfigured'),"
            + "          total_bandwidth: __call(__p, 'getTotalBandwidth'), classes: __cls });"
            + "      } catch (__pe) {}"
            + "    }"
            + "    var __rc = null;"
            + "    if (__ps.length && typeof __d.enterCommand === 'function') {"
            + "      try { var __r = __d.enterCommand('show running-config', 'enable');"
            + "        __rc = { first: String(__r.first), second: String(__r.second) }; } catch (__x) {}"
            + "    }"
            + "    reportResult(JSON.stringify({ found: true, supported: true,"
            + "      class_maps: __cs, policy_maps: __ps, running_config: __rc }));"
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
            return `'${device}' does not expose QoS (PT's hosts don't have it).`;
        }

        const cmaps = data["class_maps"] !== undefined && data["class_maps"] !== null ? data["class_maps"] : [];
        const rc = "running_config" in data ? data["running_config"] : null;
        delete data["running_config"];
        const [pmaps, warnings] = qos_policy_maps(data["policy_maps"] !== undefined && data["policy_maps"] !== null ? data["policy_maps"] : [], rc);
        data["policy_maps"] = pmaps;
        if (pyTruthy(warnings)) {
            data["warnings"] = warnings;
        }
        const custom = cmaps.filter((c) => !c["is_default"]);
        data["summary"] = (
            `${cmaps.length} class-map(s) (${custom.length} custom), `
            + `${pmaps.length} policy-map(s)`
            + pmaps.map((p) => `; ${p['name']}: ` + p["classes"].map((c) =>
                `${c['name'] || '?'}${c["priority_kbps"] ? ` priority ${c['priority_kbps']} kbps` : ""}`
                + `${c["bandwidth_kbps"] ? ` bandwidth ${c['bandwidth_kbps']} kbps` : ""}`
                + (c["fair_queue"] ? " fair-queue" : "")
              ).join(", ")).join("")
            + ". To configure QoS use pt_apply_qos."
        );
        return reply_json(data);
    });
}
