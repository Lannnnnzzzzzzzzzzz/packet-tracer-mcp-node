// Expansion-module tools: list, add, batch install.
// (Port of adapters/mcp/tools/modules.py)

import {
    module_change_js, parse_module_change, power_cycle_notes,
} from "../../../infrastructure/generator/module_js.js";
import { ALL_MODULES, resolve_module, ports_for_slot } from "../../../infrastructure/catalog/modules.js";
import { pyJsonDumps, pyRepr, pyTruthy } from "../../../shared/pycompat.js";
import { reply_json } from "../../../shared/utils.js";

export function module_target_error(spec, device_name, devices) {
    /** Why `spec` cannot go on `device_name` given the live devices, or null if it can. */
    const target = devices.find((d) => d["name"] === device_name) ?? null;
    if (target === null) {
        const names = [...new Set(devices.filter((d) => pyTruthy(d["name"])).map((d) => d["name"] ?? ""))]
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const joined = names.join(", ");
        return (
            `Error: device '${device_name}' does not exist in PT.\n`
            + `Current devices: ${pyTruthy(joined) ? joined : "(none)"}`
        );
    }
    const target_model = target["model"] || "";
    if (pyTruthy(spec.compatible_with) && pyTruthy(target_model) && !spec.compatible_with.includes(target_model)) {
        return (
            `Error: module '${spec.name}' is not compatible with model '${target_model}'.\n`
            + `Compatible with: ${[...spec.compatible_with].join(", ")}`
        );
    }
    return null;
}

export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _bridge_send_and_wait = (js, timeout) => ctx.send_and_wait(js, timeout);
    const _check_bridge = () => ctx.check_bridge();
    const _query_pt_devices = () => ctx.live_devices();

    // ------------------------------------------------------------------
    // MODULES — install expansion modules on live devices
    // ------------------------------------------------------------------

    registry.tool("pt_list_modules", async (args = {}) => {
        const { router_model = "", category = "" } = args;
        const rm = (router_model || "").trim();
        const cat = (category || "").trim().toLowerCase();

        const items = [];
        const all = ALL_MODULES instanceof Map ? [...ALL_MODULES.values()] : Object.values(ALL_MODULES);
        for (const mod of all) {
            if (pyTruthy(cat) && mod.category.toLowerCase() !== cat) {
                continue;
            }
            if (pyTruthy(rm) && pyTruthy(mod.compatible_with) && !mod.compatible_with.includes(rm)) {
                continue;
            }
            items.push({
                "name": mod.name,
                "description": mod.description,
                "category": mod.category,
                "module_type": mod.module_type,
                "ports_added": [...mod.ports_added],
                "compatible_with": pyTruthy(mod.compatible_with) ? [...mod.compatible_with] : "any",
            });
        }

        items.sort((a, b) => {
            if (a["category"] !== b["category"]) return a["category"] < b["category"] ? -1 : 1;
            return a["name"] < b["name"] ? -1 : a["name"] > b["name"] ? 1 : 0;
        });
        return reply_json({
            "count": items.length,
            "filter": { "router_model": pyTruthy(rm) ? rm : null, "category": pyTruthy(cat) ? cat : null },
            "modules": items,
        });
    });

    registry.tool("pt_add_module", async (args = {}) => {
        const { device_name, module_name, dry_run = false } = args;
        let { slot } = args;
        // Coerce slot to a string (accepts int for compatibility) and check it is not empty
        if (typeof slot === "boolean" || slot === null || slot === undefined) {
            return `Error: invalid slot (received: ${pyRepr(slot === undefined ? null : slot)}).`;
        }
        const slot_s = String(slot).trim();
        if (!pyTruthy(slot_s)) {
            return "Error: slot cannot be empty.";
        }

        // Validate the module name
        const spec = resolve_module(module_name);
        if (!spec) {
            return (
                `Error: module '${module_name}' not found in the catalog.\n`
                + `Call pt_list_modules to see the valid names.`
            );
        }

        // One generator does the power-cycle for every module tool (module_js.py):
        // it saves IOS running-configs first, since the restart reloads startup-config.
        const js = module_change_js("add", [{ "device": device_name, "slot": slot_s, "module": spec.name }]);
        // Ports carry the slot in their name, so they have to be computed
        // for THIS slot: the catalog lists them for the family's first slot.
        const slot_ports = ports_for_slot(spec, slot_s);
        const ports_added = pyTruthy(slot_ports) ? slot_ports.join(", ") : "(no ports)";

        if (dry_run) {
            // Same checks as the real call when PT is reachable; offline, only the catalog.
            const devices = pyTruthy(await _check_bridge()) ? [] : await _query_pt_devices();
            if (pyTruthy(devices)) {
                const err = module_target_error(spec, device_name, devices);
                if (err) {
                    return err;
                }
            }
            return reply_json({
                "summary": `[dry_run] Payload generated to install ${spec.name} on ${device_name} slot ${slot_s}.`,
                "device": device_name,
                "slot": slot_s,
                "module": spec.name,
                "description": spec.description,
                "ports_added": slot_ports,
                "compatible_with": pyTruthy(spec.compatible_with) ? [...spec.compatible_with] : "any",
                "js_payload": js,
                "sent": false,
                "dry_run": true,
            });
        }

        // Check bridge + PT
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        // Check the device exists and validate compatibility
        const devices = await _query_pt_devices();
        if (pyTruthy(devices)) {
            const err2 = module_target_error(spec, device_name, devices);
            if (err2) {
                return err2;
            }
        }

        const result = await _bridge_send_and_wait(js, 15.0);

        if (result === null || result === undefined) {
            return (
                `No answer from PT (timeout). Possible causes:\n`
                + `  - The module is still being installed (the power cycle can take a while)\n`
                + `  - The module name does not exist in PT's allModuleTypes\n`
                + `  - Slot '${slot_s}' is already taken or does not exist\n`
                + `Check by hand with pt_query_topology.`
            );
        }

        const data = parse_module_change(result);
        if (data === null || data === undefined) {
            return `Unexpected reply from PT: ${result}`;
        }
        const success = data["results"].some((r) => pyTruthy(r["ok"]));
        const notes = power_cycle_notes(data["devices"] ?? []).map((n) => `\n  ${n}`).join("");

        if (success) {
            return (
                `Module installed on ${device_name}.\n`
                + `  Slot: ${slot_s}\n`
                + `  Module: ${spec.name} — ${spec.description}\n`
                + `  Ports added: ${ports_added}`
                + notes
            );
        }
        return (
            `PT refused to install '${spec.name}' on ${device_name} slot '${slot_s}'.\n`
            + `Usual causes:\n`
            + `  - Slot taken by another module\n`
            + `  - Module not compatible with the device's model\n`
            + `  - Slot out of range or in the wrong format (HWIC: '0/0', NM: '1', NIM: '0/1')`
            + notes
        );
    });

    registry.tool("pt_install_modules_batch", async (args = {}) => {
        const { modules, dry_run = false } = args;
        if (!Array.isArray(modules) || !modules.length) {
            return pyJsonDumps({ "error": "modules must be a non-empty list of {device, slot, module}." });
        }

        // Validate each entry against the catalog
        const validated = [];
        const errors = [];
        for (let idx = 0; idx < modules.length; idx++) {
            const entry = modules[idx];
            if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
                errors.push(`[${idx}] is not a dict`);
                continue;
            }
            const dev = entry["device"];
            const slot = entry["slot"];
            const mod = entry["module"];
            if (!pyTruthy(dev) || typeof dev !== "string") {
                errors.push(`[${idx}] device required (str)`);
                continue;
            }
            if (slot === null || slot === undefined || typeof slot === "boolean") {
                errors.push(`[${idx}] slot required`);
                continue;
            }
            const slot_s = String(slot).trim();
            if (!pyTruthy(slot_s)) {
                errors.push(`[${idx}] empty slot`);
                continue;
            }
            if (!pyTruthy(mod) || typeof mod !== "string") {
                errors.push(`[${idx}] module required (str)`);
                continue;
            }
            const spec = resolve_module(mod);
            if (!spec) {
                errors.push(`[${idx}] module '${mod}' does not exist (use pt_list_modules)`);
                continue;
            }
            validated.push({
                "device": dev, "slot": slot_s,
                "module": spec.name,
                // Per slot, not from the catalog: two HWIC-2T in "0/0" and "0/1" give
                // different ports, and both used to be reported as 0/0.
                "ports_added": ports_for_slot(spec, slot_s),
                "compatible_with": pyTruthy(spec.compatible_with) ? [...spec.compatible_with] : null,
            });
        }

        if (errors.length) {
            return reply_json({
                "error": "Validation failed",
                "details": errors,
            });
        }

        // Build a single one-liner JS: power-off of the unique devices → addModule × N → power-on
        const unique_devs = [];
        const seen = new Set();
        for (const v of validated) {
            if (!seen.has(v["device"])) {
                seen.add(v["device"]);
                unique_devs.push(v["device"]);
            }
        }

        // One power-cycle per device around all its modules (module_js.py), with the
        // IOS running-config saved first.
        const js = module_change_js("add", validated);

        const summary = {
            "total_modules": validated.length,
            "devices_affected": unique_devs,
            "modules": validated,
            "js_payload": js,
            "dry_run": dry_run,
            "sent": false,
        };

        if (dry_run) {
            summary["summary"] = `[dry_run] ${validated.length} module(s) on ${unique_devs.length} device(s).`;
            return reply_json(summary);
        }

        const err = await _check_bridge();
        if (err) {
            return err;
        }

        // Check the devices exist + validate module compatibility
        const pt_devices = await _query_pt_devices();
        if (pyTruthy(pt_devices)) {
            const by_name = new Map(pt_devices.map((d) => [d["name"], d]));
            for (const v of validated) {
                if (!by_name.has(v["device"])) {
                    return `Error: device '${v['device']}' does not exist in PT.`;
                }
                if (pyTruthy(v["compatible_with"])) {
                    const target_model = by_name.get(v["device"])["model"] || "";
                    if (pyTruthy(target_model) && !v["compatible_with"].includes(target_model)) {
                        return (
                            `Error: module '${v['module']}' is not compatible with model `
                            + `'${target_model}' (device '${v['device']}').\n`
                            + `Compatible with: ${v["compatible_with"].join(", ")}`
                        );
                    }
                }
            }
        }

        // The result is awaited: the JS reports before powering on, so the
        // power-on — what used to force fire-and-forget — no longer counts.
        const raw = await _bridge_send_and_wait(js, 20.0);
        if (raw === null || raw === undefined) {
            summary["sent"] = true;
            summary["verified"] = false;
            summary["summary"] = (
                `Batch sent (${validated.length} module(s)) but PT did not confirm in time.\n`
                + "Check with pt_query_topology which ones were installed."
            );
            return reply_json(summary);
        }

        const data = parse_module_change(raw);
        if (data === null || data === undefined) {
            summary["sent"] = true;
            summary["verified"] = false;
            summary["summary"] = `Unexpected reply from PT: ${raw}`;
            return reply_json(summary);
        }

        // A slot that doesn't exist on the model returns false without throwing,
        // so without the per-module status phantom ports were reported.
        const status = new Map(data["results"].map((r) => [
            JSON.stringify([r["device"] ?? null, r["slot"] ?? null]), pyTruthy(r["ok"]),
        ]));
        const failed = [];
        for (const v of validated) {
            v["installed"] = status.get(JSON.stringify([v["device"] ?? null, v["slot"] ?? null])) ?? false;
            if (!v["installed"]) {
                v["ports_added"] = [];
                failed.push(`${v['device']} slot ${v['slot']} (${v['module']})`);
            }
        }
        summary["power_cycle"] = power_cycle_notes(data["devices"] ?? []);

        summary["sent"] = true;
        summary["verified"] = true;
        summary["installed_count"] = validated.filter((v) => v["installed"]).length;
        if (failed.length) {
            summary["failed"] = failed;
            summary["summary"] = (
                `${summary['installed_count']}/${validated.length} module(s) installed. `
                + `PT refused: ${failed.join(", ")}.\n`
                + "That slot does not exist on that model — check pt_list_modules and the "
                + "correct slot for the router's family."
            );
            return reply_json(summary);
        }

        summary["summary"] = (
            `Batch sent: ${validated.length} module(s) on ${unique_devs.length} device(s).\n`
            + `PT saved, powered off, installed and powered back on in one step (see power_cycle). `
            + `Check with pt_query_topology or by querying getPorts() on each router.`
        );
        return reply_json(summary);
    });
}
