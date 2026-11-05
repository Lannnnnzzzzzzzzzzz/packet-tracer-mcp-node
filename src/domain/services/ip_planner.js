// IP addressing planner.
//
// Automatically assigns subnets for LANs and inter-router links,
// generates DHCP pools, static routes and OSPF configurations.

import { IPv4Network, IPv6Network, ip_interface } from "../../shared/ipnet.js";
import { DHCPPool, StaticRoute, OSPFConfig, RIPConfig, EIGRPConfig } from "../models/plans.js";
import { SubinterfaceConfig } from "../models/vlans.js";
import { RoutingProtocol } from "../../shared/enums.js";
import { wildcard_mask, first_ip } from "../../shared/utils.js";
import { DEFAULT_DNS } from "../../shared/constants.js";
import { pyTruthy } from "../../shared/pycompat.js";

// Lazy equivalent of Python's IPv4Network.subnets(new_prefix=...) generator:
// next() hands out one subnet at a time and reports exhaustion, instead of
// materializing up to 2**(new_prefix - prefixlen) networks up front.
class _SubnetIter {
    constructor(net, new_prefix) {
        this._net = net;
        this._new_prefix = new_prefix;
        this._count = Math.pow(2, new_prefix - net.prefixlen);
        this._i = 0;
        this._step = Math.pow(2, 32 - new_prefix);
    }
    next() {
        if (this._i >= this._count) return null;
        const v = new IPv4Network((this._net._net + this._i * this._step) >>> 0, this._new_prefix);
        this._i += 1;
        return v;
    }
}

class _SubnetIter6 {
    constructor(net, new_prefix) {
        this._net = net;
        this._new_prefix = new_prefix;
        this._count = Math.pow(2, new_prefix - net.prefixlen);
        this._i = 0;
        this._step = 1n << BigInt(128 - new_prefix);
    }
    next() {
        if (this._i >= this._count) {
            // Python: next() on an exhausted generator raises StopIteration.
            throw new Error("StopIteration");
        }
        const v = new IPv6Network(this._net._v + BigInt(this._i) * this._step, this._new_prefix);
        this._i += 1;
        return v;
    }
}

const _strCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function _pairKey(a, b) {
    const s = [a, b].sort(_strCmp);
    return s[0] + "\u0000" + s[1];
}

export class IPPlanner {
    /** Assigns IPs to all interfaces of a topology plan. */

    constructor(lan_base = "192.168.0.0/16", link_base = "10.0.0.0/16") {
        this._lan_base = lan_base;
        this._link_base = link_base;
        this._lan_subnets = new _SubnetIter(new IPv4Network(lan_base), 24);
        this._link_subnets = new _SubnetIter(new IPv4Network(link_base), 30);
    }

    // `TopologyRequest` already validates that the bases yield at least one subnet, but
    // exhaustion depends on how many LANs the topology requests, which is not known
    // until this point. A raw `StopIteration` looked like a failure with no cause.

    next_lan_subnet() {
        const v = this._lan_subnets.next();
        if (v === null) {
            throw new Error(
                `Ran out of /24 subnets in ${this._lan_base}: the topology ` +
                "needs more LANs than fit. Use a shorter prefix " +
                "(192.168.0.0/16 gives 256)."
            );
        }
        return v;
    }

    next_link_subnet() {
        const v = this._link_subnets.next();
        if (v === null) {
            throw new Error(
                `Ran out of /30 subnets in ${this._link_base}: the topology ` +
                "needs more router↔router links than fit. Use a " +
                "shorter prefix (10.0.0.0/16 gives 16384)."
            );
        }
        return v;
    }

    plan_addressing(
        plan,
        routing = RoutingProtocol.STATIC,
        dhcp = true,
        floating_routes = false,
        ospf_process_id = 1,
        eigrp_as = 100,
        dual_stack = false,
        ipv6_base = "2001:db8::/32",
    ) {
        /** Assigns IPs, generates DHCP pools and routes. */
        const routers = plan.devices_by_category("router");
        const router_lans = new Map();  // name -> [IPv4Network]
        const link_subnets = new Map(); // pair key -> IPv4Network (insertion order)

        // VLAN mode (router-on-a-stick): the router↔switch link is a trunk, so it is not
        // given a single /24 — a /24 is split per VLAN via subinterfaces.
        const vlan_mode = !!pyTruthy(plan.vlans);
        if (vlan_mode) {
            this._plan_vlan_addressing(plan, dhcp);
        }

        for (const link of plan.links) {
            const dev_a = plan.device_by_name(link.device_a);
            const dev_b = plan.device_by_name(link.device_b);
            if (!dev_a || !dev_b) {
                continue;
            }

            if (vlan_mode && _is_router_switch(dev_a, dev_b)) {
                continue;  // trunk — addressed per VLAN
            }

            if (_is_router_switch(dev_a, dev_b)) {
                const router = dev_a.category === "router" ? dev_a : dev_b;
                const sw = dev_b.category === "switch" ? dev_b : dev_a;
                const r_port = dev_a.category === "router" ? link.port_a : link.port_b;

                const subnet = this.next_lan_subnet();
                const hosts = subnet.hosts();
                const gateway_ip = hosts[0].toString();
                router.interfaces[r_port] = `${gateway_ip}/${subnet.prefixlen}`;
                if (!router_lans.has(router.name)) router_lans.set(router.name, []);
                router_lans.get(router.name).push(subnet);
                this._assign_host_ips(plan, sw.name, subnet);

            } else if (dev_a.category === "router" && dev_b.category === "router") {
                const subnet = this.next_link_subnet();
                const hosts = subnet.hosts();
                dev_a.interfaces[link.port_a] = `${hosts[0].toString()}/${subnet.prefixlen}`;
                dev_b.interfaces[link.port_b] = `${hosts[1].toString()}/${subnet.prefixlen}`;
                link_subnets.set(_pairKey(dev_a.name, dev_b.name), subnet);

            } else if (_is_router_cloud(dev_a, dev_b)) {
                const router = dev_a.category === "router" ? dev_a : dev_b;
                const r_port = dev_a.category === "router" ? link.port_a : link.port_b;
                const subnet = this.next_link_subnet();
                const hosts = subnet.hosts();
                router.interfaces[r_port] = `${hosts[0].toString()}/${subnet.prefixlen}`;
            }
        }

        // DHCP pools
        if (pyTruthy(dhcp)) {
            for (const router of routers) {
                const lans = router_lans.get(router.name) ?? [];
                for (let i = 0; i < lans.length; i++) {
                    const subnet = lans[i];
                    const hosts = subnet.hosts();
                    const gw = hosts[0].toString();
                    plan.dhcp_pools.push(new DHCPPool({
                        router: router.name,
                        pool_name: `LAN_${router.name}_${i}`,
                        network: subnet.network_address.toString(),
                        mask: subnet.netmask.toString(),
                        gateway: gw, dns: DEFAULT_DNS,
                        excluded_start: gw, excluded_end: gw,
                    }));
                }
            }
        }

        // Routing
        if (routing === RoutingProtocol.STATIC) {
            this._plan_static_routes(plan, routers, router_lans, link_subnets);
            if (pyTruthy(floating_routes)) {
                this._plan_floating_static_routes(plan, routers, router_lans, link_subnets);
            }
        } else if (routing === RoutingProtocol.OSPF) {
            this._plan_ospf(plan, routers, ospf_process_id);
        } else if (routing === RoutingProtocol.EIGRP) {
            this._plan_eigrp(plan, routers, eigrp_as);
        } else if (routing === RoutingProtocol.RIP) {
            this._plan_rip(plan, routers);
        }

        // IPv6 dual-stack (routers with an ipv6 address via CLI; hosts use SLAAC)
        if (pyTruthy(dual_stack)) {
            plan.dual_stack = true;
            this._plan_ipv6_addressing(plan, ipv6_base);
        }

        return plan;
    }

    _plan_ipv6_addressing(plan, ipv6_base) {
        /** Assigns a /64 IPv6 to the router interfaces (LAN, inter-router, subinterfaces).
         *
         * Hosts do NOT get a static address: they use SLAAC (configurePcIpv6 during deploy).
         * A fixed host address is possible after the build (pt_host_ip_config's
         * ipv6_address, port.addIpv6Address measured on PT 9.0); the plan keeps SLAAC.
         */
        const pool = new _SubnetIter6(new IPv6Network(ipv6_base), 64);

        // Router-on-a-stick: one /64 per subinterface
        if (pyTruthy(plan.vlans)) {
            const routers = plan.devices_by_category("router");
            if (routers.length) {
                const router = routers[0];
                for (const sub of plan.subinterfaces) {
                    const net = pool.next();
                    const key = `${sub.parent_port}.${sub.vlan_id}`;
                    router.interfaces_v6[key] = `${net.network_address.add(1).toString()}/64`;
                }
            }
            return;
        }

        for (const link of plan.links) {
            const dev_a = plan.device_by_name(link.device_a);
            const dev_b = plan.device_by_name(link.device_b);
            if (!dev_a || !dev_b) {
                continue;
            }
            if (_is_router_switch(dev_a, dev_b)) {
                const router = dev_a.category === "router" ? dev_a : dev_b;
                const r_port = dev_a.category === "router" ? link.port_a : link.port_b;
                const net = pool.next();
                router.interfaces_v6[r_port] = `${net.network_address.add(1).toString()}/64`;
            } else if (dev_a.category === "router" && dev_b.category === "router") {
                const net = pool.next();
                dev_a.interfaces_v6[link.port_a] = `${net.network_address.add(1).toString()}/64`;
                dev_b.interfaces_v6[link.port_b] = `${net.network_address.add(2).toString()}/64`;
            } else if (_is_router_cloud(dev_a, dev_b)) {
                const router = dev_a.category === "router" ? dev_a : dev_b;
                const r_port = dev_a.category === "router" ? link.port_a : link.port_b;
                const net = pool.next();
                router.interfaces_v6[r_port] = `${net.network_address.add(1).toString()}/64`;
            }
        }
    }

    _assign_host_ips(plan, switch_name, subnet) {
        const hosts = subnet.hosts();
        const gateway_ip = hosts[0].toString();
        let host_idx = 1;

        for (const link of plan.links) {
            const dev_a = plan.device_by_name(link.device_a);
            const dev_b = plan.device_by_name(link.device_b);
            if (!dev_a || !dev_b) {
                continue;
            }

            let end_dev = null;
            let end_port = null;
            if (link.device_a === switch_name && ["pc", "server", "laptop"].includes(dev_b.category)) {
                end_dev = dev_b; end_port = link.port_b;
            } else if (link.device_b === switch_name && ["pc", "server", "laptop"].includes(dev_a.category)) {
                end_dev = dev_a; end_port = link.port_a;
            }

            if (end_dev && host_idx < hosts.length) {
                end_dev.interfaces[end_port] = `${hosts[host_idx].toString()}/${subnet.prefixlen}`;
                end_dev.gateway = gateway_ip;
                host_idx += 1;
            }
        }
    }

    _plan_vlan_addressing(plan, dhcp) {
        /** Assigns a /24 per VLAN and creates the router's .1q subinterfaces.
         *
         * Also writes the IP of each subinterface to router.interfaces["Gig0/0.N"] so that
         * OSPF/RIP/EIGRP (which iterate router.interfaces) advertise the VLANs unchanged.
         */
        const routers = plan.devices_by_category("router");
        const switches = plan.devices_by_category("switch");
        if (!routers.length || !switches.length) {
            return;
        }
        const router = routers[0], sw = switches[0];

        // Physical router port toward the switch (parent of the subinterfaces)
        let parent_port = null;
        for (const link of plan.links) {
            if (link.device_a === router.name && link.device_b === sw.name) {
                parent_port = link.port_a;
                break;
            }
            if (link.device_b === router.name && link.device_a === sw.name) {
                parent_port = link.port_b;
                break;
            }
        }
        if (!parent_port) {
            return;
        }

        const pcs = plan.devices_by_category("pc");

        const _pc_port = (pc_name) => {
            for (const link of plan.links) {
                if (link.device_a === sw.name && link.device_b === pc_name) {
                    return link.port_b;
                }
                if (link.device_b === sw.name && link.device_a === pc_name) {
                    return link.port_a;
                }
            }
            return null;
        };

        for (const vlan of plan.vlans) {
            const subnet = this.next_lan_subnet();
            const hosts = subnet.hosts();
            const gateway = hosts[0].toString();
            const prefix = subnet.prefixlen;
            vlan.subnet = `${subnet.network_address.toString()}/${prefix}`;

            // Router subinterface (the VLAN's gateway)
            const sub_key = `${parent_port}.${vlan.vlan_id}`;
            router.interfaces[sub_key] = `${gateway}/${prefix}`;
            plan.subinterfaces.push(new SubinterfaceConfig({
                router: router.name, parent_port: parent_port,
                vlan_id: vlan.vlan_id, ip_cidr: `${gateway}/${prefix}`,
            }));

            // IPs of the hosts in this VLAN
            let host_idx = 1;
            for (const pc of pcs) {
                if (pc.vlan !== vlan.vlan_id) {
                    continue;
                }
                if (host_idx >= hosts.length) {
                    break;
                }
                const pc_port = _pc_port(pc.name);
                if (pyTruthy(pc_port)) {
                    pc.interfaces[pc_port] = `${hosts[host_idx].toString()}/${prefix}`;
                    pc.gateway = gateway;
                    host_idx += 1;
                }
            }

            // DHCP pool per VLAN
            if (pyTruthy(dhcp)) {
                plan.dhcp_pools.push(new DHCPPool({
                    router: router.name,
                    pool_name: `VLAN_${vlan.vlan_id}`,
                    network: subnet.network_address.toString(),
                    mask: subnet.netmask.toString(),
                    gateway: gateway, dns: DEFAULT_DNS,
                    excluded_start: gateway, excluded_end: gateway,
                }));
            }
        }
    }

    _plan_static_routes(plan, routers, router_lans, link_subnets) {
        // Router adjacency based on the inter-router links.
        const adjacency = new Map();
        for (const r of routers) adjacency.set(r.name, new Set());
        for (const key of link_subnets.keys()) {
            const [r1, r2] = key.split("\u0000");
            if (!adjacency.has(r1)) adjacency.set(r1, new Set());
            adjacency.get(r1).add(r2);
            if (!adjacency.has(r2)) adjacency.set(r2, new Set());
            adjacency.get(r2).add(r1);
        }

        const router_by_name = new Map();
        for (const r of routers) router_by_name.set(r.name, r);

        const _first_hop = (source, target) => {
            if (source === target) {
                return null;
            }
            const seen = new Set([source]);
            const q = [[source, null]];
            let qi = 0;
            while (qi < q.length) {
                const [current, first] = q[qi++];
                for (const nxt of (adjacency.get(current) ?? new Set())) {
                    if (seen.has(nxt)) {
                        continue;
                    }
                    seen.add(nxt);
                    const first_hop = first === null ? nxt : first;
                    if (nxt === target) {
                        return first_hop;
                    }
                    q.push([nxt, first_hop]);
                }
            }
            return null;
        };

        const _ip_on_subnet = (router_name, subnet) => {
            const router = router_by_name.get(router_name);
            if (!router) {
                return null;
            }
            for (const ip_cidr of Object.values(router.interfaces)) {
                const iface = ip_interface(ip_cidr);
                if (iface.network.eq(subnet)) {
                    return iface.ip.toString();
                }
            }
            return null;
        };

        for (const router of routers) {
            for (const other of routers) {
                if (other.name === router.name) {
                    continue;
                }
                const hop = _first_hop(router.name, other.name);
                if (!hop) {
                    continue;
                }
                const subnet = link_subnets.get(_pairKey(router.name, hop));
                if (subnet === undefined || subnet === null) {
                    continue;
                }
                const next_hop = _ip_on_subnet(hop, subnet);
                if (!next_hop) {
                    continue;
                }
                for (const lan_subnet of (router_lans.get(other.name) ?? [])) {
                    plan.static_routes.push(new StaticRoute({
                        router: router.name,
                        destination: lan_subnet.network_address.toString(),
                        mask: lan_subnet.netmask.toString(),
                        next_hop: next_hop,
                    }));
                }
            }
        }
    }

    _plan_ospf(plan, routers, process_id = 1) {
        for (const router of routers) {
            const networks = [];
            for (const ip_cidr of Object.values(router.interfaces)) {
                const ip_net = ip_interface(ip_cidr);
                const network = ip_net.network;
                networks.push({
                    "network": network.network_address.toString(),
                    "wildcard": wildcard_mask({ netmask: network.netmask.toString() }),
                    "area": 0,
                });
            }
            plan.ospf_configs.push(new OSPFConfig({
                router: router.name, process_id: process_id,
                router_id: first_ip(router.interfaces),
                networks: networks,
            }));
        }
    }

    _plan_rip(plan, routers) {
        /** Generates RIP v2 configuration for all routers. */
        for (const router of routers) {
            const classless_nets = [];
            for (const ip_cidr of Object.values(router.interfaces)) {
                const ip_iface = ip_interface(ip_cidr);
                const net_addr = ip_iface.network.network_address.toString();
                if (!classless_nets.includes(net_addr)) {
                    classless_nets.push(net_addr);
                }
            }
            plan.rip_configs.push(new RIPConfig({
                router: router.name,
                version: 2,
                networks: classless_nets,
                no_auto_summary: true,
            }));
        }
    }

    _plan_eigrp(plan, routers, as_number = 100) {
        /** Generates EIGRP configuration for all routers. */
        for (const router of routers) {
            const networks = [];
            for (const ip_cidr of Object.values(router.interfaces)) {
                const ip_net = ip_interface(ip_cidr);
                const network = ip_net.network;
                const entry = {
                    "network": network.network_address.toString(),
                    "wildcard": wildcard_mask({ netmask: network.netmask.toString() }),
                };
                if (!networks.some((e) => e["network"] === entry["network"] && e["wildcard"] === entry["wildcard"])) {
                    networks.push(entry);
                }
            }
            plan.eigrp_configs.push(new EIGRPConfig({
                router: router.name,
                as_number: as_number,
                networks: networks,
                no_auto_summary: true,
            }));
        }
    }

    _plan_floating_static_routes(plan, routers, router_lans, link_subnets, admin_distance = 254) {
        /**
         * Generates floating static routes (backup) over alternative paths.
         * Only produces routes when an alternative path to the primary exists.
         */
        const adjacency = new Map();
        for (const r of routers) adjacency.set(r.name, new Set());
        for (const key of link_subnets.keys()) {
            const [r1, r2] = key.split("\u0000");
            if (!adjacency.has(r1)) adjacency.set(r1, new Set());
            adjacency.get(r1).add(r2);
            if (!adjacency.has(r2)) adjacency.set(r2, new Set());
            adjacency.get(r2).add(r1);
        }

        const router_by_name = new Map();
        for (const r of routers) router_by_name.set(r.name, r);

        const _bfs_first_hop = (source, target, blocked = null) => {
            if (source === target) {
                return null;
            }
            const seen = new Set([source, ...(blocked ?? [])]);
            const q = [[source, null]];
            let qi = 0;
            while (qi < q.length) {
                const [current, first] = q[qi++];
                for (const nxt of (adjacency.get(current) ?? new Set())) {
                    if (seen.has(nxt)) {
                        continue;
                    }
                    seen.add(nxt);
                    const first_hop = first === null ? nxt : first;
                    if (nxt === target) {
                        return first_hop;
                    }
                    q.push([nxt, first_hop]);
                }
            }
            return null;
        };

        const _ip_on_subnet = (router_name, subnet) => {
            const router = router_by_name.get(router_name);
            if (!router) {
                return null;
            }
            for (const ip_cidr of Object.values(router.interfaces)) {
                const iface = ip_interface(ip_cidr);
                if (iface.network.eq(subnet)) {
                    return iface.ip.toString();
                }
            }
            return null;
        };

        for (const router of routers) {
            for (const other of routers) {
                if (other.name === router.name) {
                    continue;
                }
                const primary_hop = _bfs_first_hop(router.name, other.name);
                if (!primary_hop) {
                    continue;
                }
                // Find alternate path by blocking the primary next hop
                const alt_hop = _bfs_first_hop(router.name, other.name, new Set([primary_hop]));
                if (!alt_hop) {
                    continue;
                }
                const subnet = link_subnets.get(_pairKey(router.name, alt_hop));
                if (subnet === undefined || subnet === null) {
                    continue;
                }
                const next_hop_ip = _ip_on_subnet(alt_hop, subnet);
                if (!next_hop_ip) {
                    continue;
                }
                for (const lan_subnet of (router_lans.get(other.name) ?? [])) {
                    plan.static_routes.push(new StaticRoute({
                        router: router.name,
                        destination: lan_subnet.network_address.toString(),
                        mask: lan_subnet.netmask.toString(),
                        next_hop: next_hop_ip,
                        admin_distance: admin_distance,
                    }));
                }
            }
        }
    }
}

function _is_router_switch(a, b) {
    return (a.category === "router" && b.category === "switch")
        || (a.category === "switch" && b.category === "router");
}

function _is_router_cloud(a, b) {
    return (a.category === "router" && b.category === "cloud")
        || (a.category === "cloud" && b.category === "router");
}
