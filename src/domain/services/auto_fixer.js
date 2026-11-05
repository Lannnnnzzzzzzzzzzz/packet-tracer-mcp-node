// Plan auto-fixer.
//
// Tries to fix common errors automatically:
//   - Change a wrong cable
//   - Change the model if ports are missing
//   - Fix interface names

import { validate_plan } from "./validator.js";
import { resolve_model, get_ports_by_speed } from "../../infrastructure/catalog/devices.js";
import { infer_cable } from "../../infrastructure/catalog/cables.js";
import { PortSpeed } from "../../shared/enums.js";

export function fix_plan(plan) {
    /**
     * Attempts to fix the plan's errors automatically.
     * Returns [fixed_plan, list_of_applied_fixes] (Python tuple).
     */
    const fixes = [];

    // Fix 1: Correct cables
    fixes.push(..._fix_cables(plan));

    // Fix 2: Upgrade routers if ports are missing
    fixes.push(..._fix_insufficient_ports(plan));

    // Fix 3: Correct invalid ports to those of the correct model
    fixes.push(..._fix_invalid_ports(plan));

    // Re-validate
    validate_plan(plan);

    return [plan, fixes];
}

function _fix_cables(plan) {
    /** Corrects cables according to the device categories. */
    const fixes = [];
    for (const link of plan.links) {
        const dev_a = plan.device_by_name(link.device_a);
        const dev_b = plan.device_by_name(link.device_b);
        if (!dev_a || !dev_b) {
            continue;
        }
        const expected = infer_cable(dev_a.category, dev_b.category);
        if (link.cable !== expected) {
            const old = link.cable;
            link.cable = expected;
            fixes.push(
                `Cable fixed: ${link.device_a}↔${link.device_b} ` +
                `from '${old}' to '${expected}'`
            );
        }
    }
    return fixes;
}

function _fix_insufficient_ports(plan) {
    /** If a router does not have enough Ethernet ports, upgrade it to 2911. */
    const fixes = [];
    const port_usage = {};

    for (const link of plan.links) {
        for (const dev_name of [link.device_a, link.device_b]) {
            port_usage[dev_name] = (port_usage[dev_name] ?? 0) + 1;
        }
    }

    for (const dev of plan.devices) {
        if (dev.category !== "router") {
            continue;
        }
        const model = resolve_model(dev.model);
        if (!model) {
            continue;
        }
        // The planner falls back to FastEthernet on a router without Gigabit (2811).
        const port_count = (get_ports_by_speed(model, PortSpeed.GIGABIT_ETHERNET).length
                      + get_ports_by_speed(model, PortSpeed.FAST_ETHERNET).length);
        const needed = port_usage[dev.name] ?? 0;

        if (needed > port_count && dev.model !== "2911") {
            const old_model = dev.model;
            dev.model = "2911";
            fixes.push(
                `Router ${dev.name} upgraded from ${old_model} to 2911 ` +
                `(needs ${needed} Ethernet ports, ${old_model} only has ${port_count})`
            );
        }
    }

    return fixes;
}

function _fix_invalid_ports(plan) {
    /** Tries to reassign invalid ports to the first available port. */
    const fixes = [];
    const used_ports = {};
    for (const d of plan.devices) used_ports[d.name] = new Set();

    // First record the ports that are already validly used
    for (const link of plan.links) {
        for (const [dev_name, port] of [[link.device_a, link.port_a], [link.device_b, link.port_b]]) {
            const dev = plan.device_by_name(dev_name);
            if (!dev) {
                continue;
            }
            const model = resolve_model(dev.model);
            if (model && model.ports.some((p) => p.full_name === port)) {
                used_ports[dev_name].add(port);
            }
        }
    }

    // Now try to fix invalid ports
    for (const link of plan.links) {
        for (const [attr_dev, attr_port] of [["device_a", "port_a"], ["device_b", "port_b"]]) {
            const dev_name = link[attr_dev];
            const port = link[attr_port];
            const dev = plan.device_by_name(dev_name);
            if (!dev) {
                continue;
            }
            const model = resolve_model(dev.model);
            if (!model) {
                continue;
            }

            if (!model.ports.some((p) => p.full_name === port)) {
                // Invalid port — look for a free one
                for (const p of model.ports) {
                    if (!used_ports[dev_name].has(p.full_name)) {
                        const old_port = port;
                        link[attr_port] = p.full_name;
                        used_ports[dev_name].add(p.full_name);
                        // The IP travels with the port. Without this, the link moved
                        // to the new interface but the addressing stayed on the old one
                        // (which no longer uses any link), so the plan came out "fixed"
                        // but inconsistent.
                        for (const ifaces of [dev.interfaces, dev.interfaces_v6]) {
                            if (old_port in ifaces) {
                                const v = ifaces[old_port];
                                delete ifaces[old_port];
                                ifaces[p.full_name] = v;
                            }
                        }
                        fixes.push(
                            `Port fixed: ${dev_name} from '${old_port}' to '${p.full_name}'`
                        );
                        break;
                    }
                }
            }
        }
    }

    return fixes;
}
