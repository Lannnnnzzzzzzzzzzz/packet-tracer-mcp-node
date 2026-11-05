// Validation rules for cables and links.

import { PlanError, ErrorCode } from "../models/errors.js";
import { pyStr } from "../../shared/pycompat.js";
import { resolve_model, get_valid_ports } from "../../infrastructure/catalog/devices.js";
import { CABLE_TYPES, infer_cable } from "../../infrastructure/catalog/cables.js";
import { ports_for_slot, resolve_module } from "../../infrastructure/catalog/modules.js";

export function validate_links(plan) {
    /** Validates links. Returns (errors, warnings). */
    const errors = [];
    const warnings = [];
    const port_usage = {};
    // Ports that the plan's modules add (an HWIC-2T in "0/1" adds Serial0/1/0-1).
    const module_ports = {};
    for (const mod of plan.modules) {
        const spec = resolve_module(mod.module);
        if (spec) {
            if (!(mod.device in module_ports)) module_ports[mod.device] = new Set();
            for (const p of ports_for_slot(spec, mod.slot)) module_ports[mod.device].add(p);
        }
    }

    for (const link of plan.links) {
        const desc = `${link.device_a}:${link.port_a} ↔ ${link.device_b}:${link.port_b}`;

        const dev_a = plan.device_by_name(link.device_a);
        const dev_b = plan.device_by_name(link.device_b);

        if (dev_a === null) {
            errors.push(new PlanError({
                code: ErrorCode.DEVICE_NOT_FOUND,
                device: link.device_a,
                message: `Link references a nonexistent device '${link.device_a}'.`,
            }));
            continue;
        }
        if (dev_b === null) {
            errors.push(new PlanError({
                code: ErrorCode.DEVICE_NOT_FOUND,
                device: link.device_b,
                message: `Link references a nonexistent device '${link.device_b}'.`,
            }));
            continue;
        }

        // Valid ports
        _check_port(errors, dev_a.name, dev_a.model, link.port_a, module_ports[dev_a.name]);
        _check_port(errors, dev_b.name, dev_b.model, link.port_b, module_ports[dev_b.name]);

        // Duplicate ports
        for (const [key, label] of [
            [`${link.device_a}:${link.port_a}`, desc],
            [`${link.device_b}:${link.port_b}`, desc],
        ]) {
            if (key in port_usage) {
                errors.push(new PlanError({
                    code: ErrorCode.PORT_ALREADY_USED,
                    device: key.split(":")[0],
                    message: `Port ${key} already in use by ${port_usage[key]}.`,
                    suggestion: "Use another free port or add a switch.",
                }));
            } else {
                port_usage[key] = label;
            }
        }

        // Valid cable
        if (!(link.cable in Object(CABLE_TYPES))) {
            errors.push(new PlanError({
                code: ErrorCode.INVALID_CABLE_TYPE,
                message: `Unknown cable type '${link.cable}' in ${desc}.`,
                suggestion: `Valid cables: ${pyStr(Object.keys(CABLE_TYPES))}`,
            }));
        }

        // Suggest the correct cable
        let expected = infer_cable(dev_a.category, dev_b.category);
        if (link.port_a.startsWith("Serial") && link.port_b.startsWith("Serial")) {
            expected = "serial";
        }
        if (link.cable !== expected) {
            warnings.push(new PlanError({
                code: ErrorCode.INVALID_CABLE_TYPE,
                message: `Cable '${link.cable}' in ${desc} may not be correct.`,
                suggestion: `Suggested cable: '${expected}'`,
            }));
        }
    }

    return [errors, warnings];
}

function _check_port(errors, dev_name, model_name, port, extra = null) {
    /** Checks that a port exists on the model (or on a module the plan installs). */
    const valid = new Set([...get_valid_ports(model_name), ...(extra || new Set())]);
    if (valid.size && !valid.has(port)) {
        const sorted_valid = [...valid].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        errors.push(new PlanError({
            code: ErrorCode.INVALID_PORT,
            device: dev_name,
            message: `Port '${port}' does not exist on model ${model_name}.`,
            suggestion: `Valid ports: ${pyStr(sorted_valid)}`,
        }));
    }
}
