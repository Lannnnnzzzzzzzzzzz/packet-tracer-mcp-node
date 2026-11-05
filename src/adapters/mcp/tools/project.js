// Project tools: config backup, project metadata, workspace options.

import { TIMEOUT_MSG } from "../bridge_context.js";
import { pyJsonDumps } from "../../../shared/pycompat.js";
import { reply_json } from "../../../shared/utils.js";


// Workspace options: MCP flag → [PT method, is it inverted?].
//
// PT exposes two of these in the NEGATIVE (`setDisableAutoCabling`,
// `setHideDevLabel`) while the MCP flag says "enable/show". If the
// inversion is lost, the tool does exactly the opposite of what it is
// asked, silently.
export const WORKSPACE_SETTERS = {
    "auto_cabling":            ["setDisableAutoCabling", true],
    "show_device_labels":      ["setHideDevLabel", true],
    "external_network_access": ["setEnableExternalNetworkAccess", false],
    "show_port_labels":        ["setIsPortShown", false],
    "show_link_lights":        ["setIsLinkLightShown", false],
};


// Setters that PT declares with a MANDATORY second argument. With only one
// it answers `Invalid arguments for IPC call "..."`. The second value does
// not change the result (tested with true and false against PT 9.0.1), but it
// has to be there.
export const WORKSPACE_EXTRA_ARG = {
    "setHideDevLabel": "true",
};


export function workspace_setter_call(flag, value) {
    /** [PT method, JS arguments] to set `flag` to `value` (0 or 1). */
    const [method, inverted] = WORKSPACE_SETTERS[flag];
    const on = ((value === 1) !== inverted) ? "true" : "false";
    const extra = WORKSPACE_EXTRA_ARG[method] !== undefined ? WORKSPACE_EXTRA_ARG[method] : null;
    return [method, (extra ? `${on}, ${extra}` : on)];
}


export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _TIMEOUT_MSG = TIMEOUT_MSG;
    const _bridge_send_and_wait = async (js, timeout) => await ctx.send_and_wait(js, timeout);
    const _check_bridge = async () => await ctx.check_bridge();

    // ------------------------------------------------------------------
    // Project BACKUP and METADATA
    // ------------------------------------------------------------------

    // The startup-config comes back with the lines separated by COMMAS, not by
    // newlines. Rebuilding it is what makes it pasteable into a CLI.
    const _MAX_BACKUP_XML = 200_000;

    registry.tool("pt_backup_config", async (args) => {
        const device = args.device;
        const include_xml = args.include_xml !== undefined ? args.include_xml : false;
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const dev = pyJsonDumps(device.trim());
        const want_xml = include_xml ? "true" : "false";
        const js = (
            "try {"
            + `  var __d = ipc.network().getDevice(${dev});`
            + "  if (!__d) { reportResult(JSON.stringify({ found: false })); }"
            + "  else if (typeof __d.getStartupFile !== 'function') {"
            + "    reportResult(JSON.stringify({ found: true, supported: false }));"
            + "  } else {"
            + "    var __out = { found: true, supported: true,"
            + "      startup: String(__d.getStartupFile() || ''),"
            + "      model: (typeof __d.getModel === 'function') ? __d.getModel() : '',"
            + "      hostname: (typeof __d.getHostName === 'function') ? __d.getHostName() : '',"
            + "      serial: (typeof __d.getSerialNumber === 'function') ? __d.getSerialNumber() : '',"
            + "      config_register: (typeof __d.getConfigRegister === 'function')"
            + "        ? __d.getConfigRegister() : null,"
            + "      uptime: (typeof __d.getUpTime === 'function') ? __d.getUpTime() : null,"
            + "      boot_systems: (typeof __d.getBootSystems === 'function')"
            + "        ? String(__d.getBootSystems() || '') : '' };"
            + `    if (${want_xml} && typeof __d.serializeToXml === 'function') {`
            + `      __out.xml = String(__d.serializeToXml() || '').substring(0, ${_MAX_BACKUP_XML});`
            + "    }"
            + "    reportResult(JSON.stringify(__out));"
            + "  }"
            + "} catch (__e) { reportResult('ERROR:' + __e); }"
        );

        const raw = await _bridge_send_and_wait(js, 20.0);
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
            return `'${device}' has no startup-config (PT's hosts don't have one).`;
        }

        const startup = data["startup"] !== undefined && data["startup"] !== null ? data["startup"] : "";
        delete data["startup"];
        const lines = startup.split(",").filter((ln) => ln !== "");
        data["startup_config"] = lines.join("\n");
        data["startup_lines"] = lines.length;
        if (!lines.length) {
            data["summary"] = (
                `'${device}' has no saved startup-config. `
                + "Run `write memory` on the device before backing it up."
            );
        } else {
            data["summary"] = (
                `${lines.length} line(s) of startup-config from '${device}' `
                + `(${data['model'] !== undefined && data['model'] !== null ? data['model'] : "None"}, serial ${data['serial'] !== undefined && data['serial'] !== null ? data['serial'] : "None"}).`
            );
        }
        return reply_json(data);
    });

    registry.tool("pt_project_metadata", async (args) => {
        const description = args.description !== undefined ? args.description : "";
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const new_desc = description.trim();
        const setter = (
            new_desc ? (
            `  if (typeof __f.setNetworkDescription === 'function') `
            + `{ __f.setNetworkDescription(${pyJsonDumps(new_desc)}); }`
            ) : ""
        );
        const js = (
            "try {"
            + "  var __a = ipc.appWindow();"
            + "  var __f = __a.getActiveFile();"
            + "  if (!__f) { reportResult(JSON.stringify({ found: false })); } else {"
            + setter +
            "    var __n = ipc.network();"
            + "    reportResult(JSON.stringify({"
            + "      found: true,"
            + "      saved_filename: String(__f.getSavedFilename() || ''),"
            + "      pt_version: String(__f.getVersion() || ''),"
            + "      description: String(__f.getNetworkDescription() || ''),"
            + "      devices: __n.getDeviceCount(), links: __n.getLinkCount()"
            + "    }));"
            + "  }"
            + "} catch (__e) { reportResult('ERROR:' + __e); }"
        );

        const raw = await _bridge_send_and_wait(js, 10.0);
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
            return "PT has no active network file.";
        }

        data["updated_description"] = Boolean(new_desc);
        const saved = data["saved_filename"] || "";
        data["summary"] = (
            `${data['devices']} device(s), ${data['links']} link(s). `
            + (saved ? `File: ${saved}.` : "Project NOT saved — use pt_save_project to persist it.")
            + (new_desc ? " Description updated." : "")
        );
        return reply_json(data);
    });

    registry.tool("pt_workspace_options", async (args) => {
        const auto_cabling = args.auto_cabling !== undefined ? args.auto_cabling : -1;
        const external_network_access = args.external_network_access !== undefined ? args.external_network_access : -1;
        const show_port_labels = args.show_port_labels !== undefined ? args.show_port_labels : -1;
        const show_link_lights = args.show_link_lights !== undefined ? args.show_link_lights : -1;
        const show_device_labels = args.show_device_labels !== undefined ? args.show_device_labels : -1;
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        function _opt_set(method, args_str) {
            /** One isolated setter: if PT rejects it, it falls alone and is reported.
             *
             * Each one goes in its own try/catch on purpose. They used to all be
             * under the same one, so one failing setter — `setHideDevLabel` with
             * the wrong arity — aborted the whole batch and returned a raw
             * error, but the earlier ones HAD ALREADY been applied: the user saw
             * "failed" with half the changes in place.
             */
            return (
                `    try { if (typeof __o.${method} === 'function')`
                + ` { __o.${method}(${args_str}); __applied.push('${method}'); }`
                + ` else { __failed.push('${method}: does not exist'); } }`
                + ` catch (__se) { __failed.push('${method}: ' + __se); }`
            );
        }

        // The polarity and arity live in WORKSPACE_SETTERS /
        // WORKSPACE_EXTRA_ARG (module level) so they can be tested without PT.
        const sets = [];
        for (const [flag, value] of [
            ["auto_cabling", auto_cabling],
            ["show_device_labels", show_device_labels],
            ["external_network_access", external_network_access],
            ["show_port_labels", show_port_labels],
            ["show_link_lights", show_link_lights],
        ]) {
            if (value === 0 || value === 1) {
                sets.push(_opt_set(...workspace_setter_call(flag, value)));
            }
        }

        const js = (
            "try {"
            + "  var __o = ipc.options();"
            + "  var __applied = []; var __failed = [];"
            + sets.join("") +
            "  reportResult(JSON.stringify({"
            + "    applied: __applied, failed: __failed,"
            + "    auto_cabling: !__o.isAutoCablingDisabled(),"
            + "    external_network_access: !!__o.isExternalNetworkAccessEnabled(),"
            + "    show_port_labels: !!__o.isPortShown(),"
            + "    show_link_lights: !!__o.isLinkLightsShown(),"
            + "    show_device_labels: !__o.isHideDevLabel(),"
            + "    using_metric: !!__o.isUsingMetric(),"
            + "    language: String(__o.getCurrentLanguage() || ''),"
            + "    config_path: String(__o.getConfigFilePath() || '')"
            + "  }));"
            + "} catch (__e) { reportResult('ERROR:' + __e); }"
        );

        const raw = await _bridge_send_and_wait(js, 10.0);
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

        // What PT really accepted, not what was attempted: counting the attempts
        // gave "5 options changed" even when one had been rejected.
        const applied = data["applied"] || [];
        const failed = data["failed"] || [];
        data["changed"] = applied.length;
        const notes = [];
        if (!data["auto_cabling"]) {
            notes.push("auto-cabling OFF (you pick the ports)");
        }
        if (data["external_network_access"]) {
            notes.push("⚠ access to the REAL network enabled");
        }
        if (failed.length) {
            notes.push(`⚠ ${failed.length} option(s) rejected by PT: ${failed.join("; ")}`);
        }
        data["summary"] = (
            (sets.length ? `${applied.length} option(s) changed. ` : "Read only. ")
        ) + (notes.length ? notes.join("; ") : "Default configuration.");
        return reply_json(data);
    });
}
