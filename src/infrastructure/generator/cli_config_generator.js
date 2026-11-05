// IOS CLI configuration generator for Packet Tracer devices.
//
// From the TopologyPlan, generates command blocks ready to
// paste into the terminal of each router/switch.

import { pyTruthy } from "../../shared/pycompat.js";
import { ip_network, ip_address, ip_interface } from "../../shared/ipnet.js";
import { prefix_to_mask } from "../../shared/utils.js";
import {
    generate_switch_vlan_cli, generate_router_subinterface_cli, switch_supports_encap,
} from "./vlan_cli_generator.js";

export function generate_all_configs(plan) {
    // Generates CLI configs for every device that needs one.
    // Returns {device_name: cli_block}.
    const configs = {};

    for (const dev of plan.devices) {
        if (dev.category === "router") {
            configs[dev.name] = _router_config(dev, plan);
        } else if (dev.category === "switch" && pyTruthy(dev.interfaces) && switch_supports_encap(dev.model)) {
            // A multilayer switch with addresses routes: routed ports, SVIs, OSPF, DHCP.
            configs[dev.name] = _router_config(dev, plan, true);
        } else if (dev.category === "switch") {
            const cfg = _switch_config(dev, plan);
            if (pyTruthy(cfg.trim())) {
                configs[dev.name] = cfg;
            }
        }
    }

    for (const [name, extra] of Object.entries(plan.extra_cli)) {
        if (name in configs && pyTruthy(extra)) {
            configs[name] = _with_extra_cli(configs[name], extra);
        }
    }

    return configs;
}

export function static_host_ips(plan) {
    // {host_name: ip} of the wired hosts deployed with a fixed IP even when DHCP is on:
    // the servers. The router pools must exclude these addresses, or a lease can
    // duplicate them.
    //
    // The last host of each subnet used to be static too (Fix F17: it sometimes never
    // completed its DISCOVER). The cause was STP: the request left while the switch port
    // was still listening. pt_live_deploy now re-requests every lease once STP settles,
    // so that host takes DHCP like the others instead of being the one PC of a DHCP lab
    // with a hand-set address, missing from the lease report (measured on PT 9.0.1).
    if (!pyTruthy(plan.dhcp_pools)) {
        return {};
    }
    const statik = {};
    for (const dev of plan.devices) {
        if (dev.category !== "server" || !pyTruthy(dev.interfaces)) {
            continue;
        }
        const iface_ip = Object.values(dev.interfaces)[0] !== undefined ? Object.values(dev.interfaces)[0] : null;
        if (pyTruthy(iface_ip)) {
            statik[dev.name] = iface_ip.split("/")[0];
        }
    }
    return statik;
}

function _with_extra_cli(cfg, extra) {
    // Insert the plan's extra lines before the trailing `end` / `write memory`.
    const lines = cfg.split("\n");
    const tail = (lines.slice(-2).join("\u0000") === ["end", "write memory"].join("\u0000")) ? lines.slice(-2) : [];
    const head = lines.slice(0, lines.length - tail.length);
    return head.concat([...extra]).concat(tail).join("\n");
}

function _ospf_point_to_point_interfaces(router, plan) {
    // The router's /30 interfaces that an OSPF `network` statement covers.
    //
    // Set point-to-point at deploy time: as broadcast they sit in 2WAY/DROTHER waiting
    // for a DR election, and changing the type afterwards makes PT flush the ASBR's
    // default route (see interface_tuning_cli_generator).
    const nets = [];
    for (const o of plan.ospf_configs) {
        if (o.router !== router.name) continue;
        for (const n of o.networks) {
            nets.push(ip_network(`${n['network']}/${n['wildcard']}`, false));
        }
    }
    const out = new Set();
    for (const [iface, ip_cidr] of Object.entries(router.interfaces)) {
        const addr = ip_interface(ip_cidr);
        if (addr.network.prefixlen === 30 && nets.some((n) => n.contains(addr.ip))) {
            out.add(iface);
        }
    }
    return out;
}

function _router_config(router, plan, l3_switch = false) {
    // Generates the full config of a router (or of a layer-3 multilayer switch).
    const lines = [];

    lines.push("enable");
    lines.push("configure terminal");
    lines.push(`hostname ${router.name}`);
    lines.push("no ip domain-lookup");
    if (pyTruthy(router.interfaces_v6)) {
        lines.push("ipv6 unicast-routing");
    }
    if (l3_switch) {
        lines.push("ip routing");
        // VLANs first: an SVI for a VLAN that does not exist stays down.
        const access = plan.access_ports.filter((a) => a.switch === router.name);
        const trunks = plan.trunks.filter((t) => t.switch === router.name);
        if (pyTruthy(access) || pyTruthy(trunks) || pyTruthy(plan.vlans)) {
            lines.push(...generate_switch_vlan_cli(plan.vlans, access, trunks, true));
        }
    }
    lines.push("");

    // --- Physical interfaces (the "Gig0/0.10" subinterfaces are emitted separately with
    //     their `encapsulation dot1Q`, so we skip them here) ---
    const ospf_p2p = _ospf_point_to_point_interfaces(router, plan);
    for (const [iface, ip_cidr] of Object.entries(router.interfaces)) {
        if (iface.includes(".")) {
            continue;
        }
        const [ip, prefix] = ip_cidr.split("/");
        const mask = prefix_to_mask(parseInt(prefix, 10));
        lines.push(`interface ${iface}`);
        if (l3_switch && !iface.toLowerCase().startsWith("vlan")) {
            lines.push(" no switchport");
        }
        lines.push(` ip address ${ip} ${mask}`);
        if (ospf_p2p.has(iface)) {
            lines.push(" ip ospf network point-to-point");
        }
        // IPv6 on the same physical interface (dual-stack), if applicable
        const v6 = router.interfaces_v6[iface];
        if (pyTruthy(v6)) {
            lines.push(` ipv6 address ${v6}`);
            lines.push(" ipv6 enable");
        }
        lines.push(" no shutdown");
        lines.push(" exit");
        lines.push("");
    }

    // --- Subinterfaces .1q (inter-VLAN routing / router-on-a-stick) ---
    const subifs = plan.subinterfaces.filter((s) => s.router === router.name);
    if (pyTruthy(subifs)) {
        lines.push(...generate_router_subinterface_cli(subifs, router.interfaces_v6));
        lines.push("");
    }

    // --- DHCP ---
    const pools = plan.dhcp_pools.filter((p) => p.router === router.name);
    const static_ips = [...new Set(Object.values(static_host_ips(plan)))].sort((a, b) => ip_address(a).cmp(ip_address(b)));
    for (const pool of pools) {
        lines.push(`ip dhcp excluded-address ${pool.excluded_start} ${pool.excluded_end}`);
        const pool_net = ip_network(`${pool.network}/${pool.mask}`, false);
        for (const ip of static_ips) {
            if (pool_net.contains(ip_address(ip))) {
                lines.push(`ip dhcp excluded-address ${ip}`);
            }
        }
    }
    for (const pool of pools) {
        lines.push(`ip dhcp pool ${pool.pool_name}`);
        lines.push(` network ${pool.network} ${pool.mask}`);
        lines.push(` default-router ${pool.gateway}`);
        lines.push(` dns-server ${pool.dns}`);
        lines.push(" exit");
        lines.push("");
    }

    // --- Static routes ---
    const static_routes = plan.static_routes.filter((r) => r.router === router.name);
    for (const route of static_routes) {
        let line = `ip route ${route.destination} ${route.mask} ${route.next_hop}`;
        if (route.admin_distance !== 1) {
            line += ` ${route.admin_distance}`;
        }
        lines.push(line);
    }
    if (pyTruthy(static_routes)) {
        lines.push("");
    }

    // --- OSPF ---
    const ospf_cfgs = plan.ospf_configs.filter((o) => o.router === router.name);
    for (const ospf of ospf_cfgs) {
        lines.push(`router ospf ${ospf.process_id}`);
        if (pyTruthy(ospf.router_id)) {
            lines.push(` router-id ${ospf.router_id}`);
        }
        for (const net of ospf.networks) {
            lines.push(
                ` network ${net['network']} ${net['wildcard']} area ${net['area']}`
            );
        }
        lines.push(" exit");
        lines.push("");
    }

    // --- RIP ---
    const rip_cfgs = plan.rip_configs.filter((r) => r.router === router.name);
    for (const rip of rip_cfgs) {
        lines.push(`router rip`);
        lines.push(` version ${rip.version}`);
        for (const net of rip.networks) {
            lines.push(` network ${net}`);
        }
        if (rip.no_auto_summary) {
            lines.push(" no auto-summary");
        }
        lines.push(" exit");
        lines.push("");
    }

    // --- EIGRP ---
    const eigrp_cfgs = plan.eigrp_configs.filter((e) => e.router === router.name);
    for (const eigrp of eigrp_cfgs) {
        lines.push(`router eigrp ${eigrp.as_number}`);
        for (const net of eigrp.networks) {
            lines.push(` network ${net['network']} ${net['wildcard']}`);
        }
        if (eigrp.no_auto_summary) {
            lines.push(" no auto-summary");
        }
        lines.push(" exit");
        lines.push("");
    }

    lines.push("end");
    lines.push("write memory");

    return lines.join("\n");
}

function _switch_config(switch_dev, plan) {
    // Generates the config of a switch: hostname + (if any) VLANs/access/trunks.
    const lines = [];
    lines.push("enable");
    lines.push("configure terminal");
    lines.push(`hostname ${switch_dev.name}`);

    // VLAN / access / trunk for this switch
    const access = plan.access_ports.filter((a) => a.switch === switch_dev.name);
    const trunks = plan.trunks.filter((t) => t.switch === switch_dev.name);
    // The declared VLANs that have at least one port on this switch (or all of them,
    // if the plan defines them globally). We keep all of the plan's VLANs for simplicity.
    if (pyTruthy(access) || pyTruthy(trunks) || pyTruthy(plan.vlans)) {
        const vlan_lines = generate_switch_vlan_cli(
            plan.vlans, access, trunks, switch_supports_encap(switch_dev.model)
        );
        lines.push(...vlan_lines);
    }

    lines.push("end");
    lines.push("write memory");
    return lines.join("\n");
}

export function generate_pc_config(device, use_dhcp = null) {
    // Generates configuration instructions for a PC.
    const lines = [];
    lines.push(`--- ${device.name} ---`);

    if (pyTruthy(device.interfaces)) {
        for (const [iface, ip_cidr] of Object.entries(device.interfaces)) {
            const [ip, prefix] = ip_cidr.split("/");
            const mask = prefix_to_mask(parseInt(prefix, 10));
            lines.push(`IP Address: ${ip}`);
            lines.push(`Subnet Mask: ${mask}`);
        }
    }
    if (pyTruthy(device.gateway)) {
        lines.push(`Default Gateway: ${device.gateway}`);
    }
    lines.push("DNS Server: 8.8.8.8");
    if (use_dhcp) {
        lines.push("Set to DHCP to get an IP automatically.");
    } else {
        lines.push("Set a static IP with the values above.");
    }
    return lines.join("\n");
}
