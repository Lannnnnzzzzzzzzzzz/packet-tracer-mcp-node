// PTBuilder script generator.
//
// Converts a validated TopologyPlan into JavaScript compatible
// with the PTBuilder extension for Packet Tracer.

import { pyJsonDumps, pyTruthy } from "../../shared/pycompat.js";
import { ip_network, ip_address } from "../../shared/ipnet.js";
import {
    pt_device_type,
    PT_CONNECT_TYPE,
    PT_CONNECT_TYPE_DEFAULT,
} from "../../shared/constants.js";
import { generate_all_configs, static_host_ips } from "./cli_config_generator.js";
import { prefix_to_mask } from "../../shared/utils.js";

// ONE way to create devices and links, for the deploy script and the live tools
// alike: the extension's lwAddDevice (logical workspace, with a fallback to the
// global addDevice for models lw.addDevice silently refuses, e.g. Laptop-PT) and
// lwAddLink (numeric CONNECT_TYPE). core.js's addDevice/addLink stay in the
// extension for pt_send_raw users; nothing in Python calls them directly.

export function add_device_call(name, model, category, x, y) {
    // `lwAddDevice(...)` for one device, every text field through json.dumps.
    return (
        `lwAddDevice(${pyJsonDumps(name)}, ${pt_device_type(model, category)}, `
        + `${pyJsonDumps(model)}, ${parseInt(x, 10)}, ${parseInt(y, 10)})`
    );
}

export function add_link_call(device_a, port_a, device_b, port_b, cable) {
    // `lwAddLink(...)` for one link, with PT's numeric CONNECT_TYPE for `cable`.
    const connect_type = Object.prototype.hasOwnProperty.call(PT_CONNECT_TYPE, cable) ? PT_CONNECT_TYPE[cable] : PT_CONNECT_TYPE_DEFAULT;
    return (
        `lwAddLink(${pyJsonDumps(device_a)}, ${pyJsonDumps(port_a)}, `
        + `${pyJsonDumps(device_b)}, ${pyJsonDumps(port_b)}, ${connect_type})`
    );
}

export function generate_ptbuilder_script(plan) {
    // Generates a PTBuilder JS script from a validated plan.
    //
    // Uses lwAddDevice/lwAddLink (helpers injected as runtime patches) instead of the
    // global addDevice/addLink — the helpers write to PT's Logical canvas, so devices
    // and cables appear immediately without needing a save+reload.
    const lines = [];

    // json.dumps on every text field: a name with quotes or line breaks broke the
    // JS literal and the rest was executed as code in the Script Engine.
    // It is the same pattern that generate_executable_script() below already uses.
    for (const dev of plan.devices) {
        lines.push(add_device_call(dev.name, dev.model, dev.category, dev.x, dev.y) + ";");
    }

    // WiFi laptops: swap the ethernet NIC for a wireless one (→ Wireless0). It must go
    // before the links/config; auto-association to the AP is over RF (default SSID).
    for (const dev of plan.devices) {
        if (dev.category === "laptop" && dev.wireless) {
            lines.push(`swapLaptopToWireless(${pyJsonDumps(dev.name)});`);
        }
    }

    for (const mod of plan.modules) {
        lines.push(
            `addModule(${pyJsonDumps(mod.device)}, ${pyJsonDumps(mod.slot)}, `
            + `${pyJsonDumps(mod.module)});`
        );
    }

    for (const link of plan.links) {
        lines.push(add_link_call(link.device_a, link.port_a, link.device_b, link.port_b,
                                   link.cable) + ";");
    }

    return lines.join("\n");
}

export function generate_executable_script(plan) {
    // Generates a complete, executable JS script: devices, links,
    // configureIosDevice() for routers/switches, and configurePcIp() for PCs.
    const lines = [];
    lines.push(generate_ptbuilder_script(plan));

    const configs = generate_all_configs(plan);
    for (const [device_name, cli_block] of Object.entries(configs)) {
        lines.push(`configureIosDevice(${pyJsonDumps(device_name)}, ${pyJsonDumps(cli_block)});`);
    }

    // Hosts keep the extension's configurePcIp here instead of host_js.host_ip_config_js
    // (what pt_host_ip_config sends), on purpose:
    // - host_ip_config_js runs dhcpRun at once. In the deploy the routers' DHCP pools
    //   are still being configured, so the request would fail; configurePcIp only sets
    //   the DHCP flag and the lease is renewed after the deploy (renew_dhcp_leases).
    // - it reports through reportResult, and the deploy lines are queued
    //   fire-and-forget: every host would push an unread result onto the bridge.
    // - it is ~3.5 KB per host against ~60 bytes, on a script that can hold
    //   a hundred hosts.
    const pcs = plan.devices.filter((d) => ["pc", "server", "laptop"].includes(d.category));

    // Servers and the last host of each subnet keep their planned IP (Fix F17);
    // the router pools exclude those same addresses.
    const static_names = new Set(Object.keys(static_host_ips(plan)));
    const pool_nets = plan.dhcp_pools.map((p) => [ip_network(`${p.network}/${p.mask}`, false), p]);

    for (const pc of pcs) {
        if (pyTruthy(pc.interfaces)) {
            const iface_ip = Object.values(pc.interfaces)[0] !== undefined ? Object.values(pc.interfaces)[0] : null;
            if (pyTruthy(iface_ip)) {
                const [ip, prefix] = iface_ip.split("/");
                const mask = prefix_to_mask(parseInt(prefix, 10));
                const gw = pc.gateway || "";
                const found = pool_nets.find(([net, p]) => net.contains(ip_address(ip)));
                const pool = found ? found[1] : null;
                // DHCP only where a pool serves the host's subnet; servers keep the
                // planned address (DNS/web need a fixed one).
                const use_dhcp = !static_names.has(pc.name) && pool !== null;
                if (use_dhcp) {
                    lines.push(`configurePcIp(${pyJsonDumps(pc.name)}, true);`);
                } else {
                    // A static host on a pool's subnet takes that pool's DNS, as a
                    // lease would have given it.
                    const dns = (pool !== null && pyTruthy(pool.dns)) ? `, ${pyJsonDumps(pool.dns)}` : "";
                    lines.push(
                        `configurePcIp(${pyJsonDumps(pc.name)}, false, `
                        + `${pyJsonDumps(ip)}, ${pyJsonDumps(mask)}, ${pyJsonDumps(gw)}${dns});`
                    );
                }
            }
        } else if (pc.wireless && pyTruthy(plan.dhcp_pools)) {
            // WiFi laptop with no wired link: gets DHCP via Wireless0 (associated with the AP).
            lines.push(`configurePcIp(${pyJsonDumps(pc.name)}, true);`);
        }
        // IPv6 dual-stack: host via SLAAC (auto-config from the router's RA)
        if (plan.dual_stack) {
            lines.push(`configurePcIpv6(${pyJsonDumps(pc.name)});`);
        }
    }

    return lines.join("\n");
}

export function generate_full_script(plan) {
    // Generates the complete script: PTBuilder + the CLI configuration block
    // as comments (for visual reference).
    const parts = [];
    parts.push(generate_ptbuilder_script(plan));

    const configs = generate_all_configs(plan);
    if (pyTruthy(configs)) {
        parts.push("/* === CLI configuration per device ===");
        parts.push("Copy and paste into each device's CLI. */");
        for (const [device_name, cli_block] of Object.entries(configs)) {
            parts.push(`/* --- ${device_name} ---`);
            for (const line of cli_block.split("\n")) {
                parts.push(line);
            }
            parts.push("*/ ");
        }
    }

    return parts.join("\n");
}
