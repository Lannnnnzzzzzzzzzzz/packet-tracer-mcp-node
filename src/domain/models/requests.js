// Request models — what comes in from the LLM.

import { RoutingProtocol, TopologyTemplate } from "../../shared/enums.js";
import {
    DEFAULT_ROUTER, DEFAULT_SWITCH,
    DEFAULT_LAN_BASE, DEFAULT_LINK_BASE,
} from "../../shared/constants.js";
import { IPv4Address, IPv4Network, IPv6Address, IPv6Network } from "../../shared/ipnet.js";

// The size of the subnets IPPlanner carves from each pool. A base with a prefix
// longer than this cannot yield even one subnet.
const _REQUIRED_PREFIX = {
    "base_network": 24,          // one /24 per LAN
    "inter_router_network": 30,  // one /30 per router↔router link
};

function _int(v) { return typeof v === "string" ? parseInt(v, 10) : v; }

function _check_range(field, value, ge, le) {
    // pydantic Field(ge=..., le=...)
    if (value === null || value === undefined) return value;
    const v = _int(value);
    if (ge !== undefined && v < ge) throw new Error(`${field}: Input should be greater than or equal to ${ge}`);
    if (le !== undefined && v > le) throw new Error(`${field}: Input should be less than or equal to ${le}`);
    return v;
}

function _parse_ipv4_network_strict(v) {
    /** Python ipaddress.IPv4Network(v) with strict=True (the default). Throws Error. */
    const s = String(v);
    const parts = s.split("/");
    if (parts.length > 2) throw new Error(`'${s}' does not appear to be an IPv4 address`);
    let addr;
    try {
        addr = new IPv4Address(parts[0]);
    } catch (e) {
        throw new Error(e.message);
    }
    let prefixlen = 32;
    if (parts.length === 2) {
        const p = parts[1];
        if (p.includes(".")) {
            // dotted netmask
            let mask;
            try { mask = new IPv4Address(p); } catch { throw new Error(`'${p}' is not a valid netmask`); }
            const bits = (mask._int >>> 0).toString(2);
            if (!/^1*0*$/.test(bits.padStart(32, "0"))) throw new Error(`'${p}' is not a valid netmask`);
            prefixlen = bits.split("").filter((c) => c === "1").length;
        } else {
            if (!/^-?\d+$/.test(p.trim())) throw new Error(`'${p}' is not a valid netmask`);
            prefixlen = parseInt(p, 10);
            if (prefixlen < 0 || prefixlen > 32) throw new Error(`'${p}' is not a valid netmask`);
        }
    }
    const net = new IPv4Network(addr._int, prefixlen);
    if (net.network_address._int !== addr._int) {
        throw new Error(`${s} has host bits set`);
    }
    return net;
}

function _parse_ipv6_network_strict(v) {
    /** Python ipaddress.IPv6Network(v) with strict=True (the default). Throws Error. */
    const s = String(v);
    const ipPart = s.split("/")[0];
    let addr;
    try {
        addr = new IPv6Address(ipPart);
    } catch (e) {
        throw new Error(e.message);
    }
    let net;
    try {
        net = new IPv6Network(s);
    } catch (e) {
        throw new Error(e.message);
    }
    if (s.includes("/")) {
        const plenStr = s.split("/")[1];
        if (!/^-?\d+$/.test(plenStr.trim()) || parseInt(plenStr, 10) < 0 || parseInt(plenStr, 10) > 128) {
            throw new Error(`'${plenStr}' is not a valid netmask`);
        }
    }
    if (net.network_address._v !== addr._v) {
        throw new Error(`${s} has host bits set`);
    }
    return net;
}

export class TopologyRequest {
    /** High-level request — what the LLM generates from the user. */
    constructor(obj = {}) {
        this.template = obj.template !== undefined ? obj.template : TopologyTemplate.MULTI_LAN;
        this.routers = obj.routers !== undefined ? _check_range("routers", obj.routers, 1, 20) : 2;
        this.switches_per_router = obj.switches_per_router !== undefined ? _check_range("switches_per_router", obj.switches_per_router, 0, 4) : 1;
        this.pcs_per_lan = obj.pcs_per_lan !== undefined ? (Array.isArray(obj.pcs_per_lan) ? [...obj.pcs_per_lan] : obj.pcs_per_lan) : 3;
        this.laptops_per_lan = obj.laptops_per_lan !== undefined ? (Array.isArray(obj.laptops_per_lan) ? [...obj.laptops_per_lan] : obj.laptops_per_lan) : 0;
        this.servers = obj.servers !== undefined ? _check_range("servers", obj.servers, 0, 10) : 0;
        this.access_points = obj.access_points !== undefined ? _check_range("access_points", obj.access_points, 0, 20) : 0;
        this.has_wan = obj.has_wan !== undefined ? obj.has_wan : false;
        this.dhcp = obj.dhcp !== undefined ? obj.dhcp : true;
        this.routing = obj.routing !== undefined ? obj.routing : RoutingProtocol.STATIC;
        this.router_model = obj.router_model !== undefined ? obj.router_model : DEFAULT_ROUTER;
        this.switch_model = obj.switch_model !== undefined ? obj.switch_model : DEFAULT_SWITCH;
        this.base_network = obj.base_network !== undefined ? TopologyRequest._pool_can_yield_subnets(obj.base_network, "base_network") : TopologyRequest._pool_can_yield_subnets(DEFAULT_LAN_BASE, "base_network");
        this.inter_router_network = obj.inter_router_network !== undefined ? TopologyRequest._pool_can_yield_subnets(obj.inter_router_network, "inter_router_network") : TopologyRequest._pool_can_yield_subnets(DEFAULT_LINK_BASE, "inter_router_network");
        // Advanced routing options
        this.floating_routes = obj.floating_routes !== undefined ? obj.floating_routes : false; // Generates backup static routes (AD=254)
        this.ospf_process_id = obj.ospf_process_id !== undefined ? _check_range("ospf_process_id", obj.ospf_process_id, 1, 65535) : 1;
        this.eigrp_as = obj.eigrp_as !== undefined ? _check_range("eigrp_as", obj.eigrp_as, 1, 65535) : 100;
        // VLAN (router-on-a-stick): number of VLANs to spread across the PCs (0 = default 2)
        this.vlans = obj.vlans !== undefined ? _check_range("vlans", obj.vlans, 0, 64) : 0;
        // IPv6 dual-stack
        this.dual_stack = obj.dual_stack !== undefined ? obj.dual_stack : false;
        this.ipv6_base = obj.ipv6_base !== undefined ? TopologyRequest._ipv6_pool_can_yield_subnets(obj.ipv6_base) : TopologyRequest._ipv6_pool_can_yield_subnets("2001:db8::/32");
        // Laptops connected over WiFi (wireless NIC + an AP auto-associated per LAN)
        this.wireless_laptops = obj.wireless_laptops !== undefined ? obj.wireless_laptops : false;
        // Visible area of PT's logical view (px). None = layout.DEFAULT_CANVAS; the tools fill
        // it from the live canvas when the bridge is up.
        this.canvas_width = obj.canvas_width !== undefined && obj.canvas_width !== null ? _check_range("canvas_width", obj.canvas_width, 400, 8000) : (obj.canvas_width !== undefined ? null : null);
        this.canvas_height = obj.canvas_height !== undefined && obj.canvas_height !== null ? _check_range("canvas_height", obj.canvas_height, 300, 5000) : (obj.canvas_height !== undefined ? null : null);
    }

    static _pool_can_yield_subnets(v, field_name) {
        /** The base has to be a valid network and yield at least one subnet.
         *
         * Without this the value reached `IPPlanner` raw, where a `/25` died
         * with `new prefix must be longer`, a `/24` with a bare `StopIteration`
         * when asking for the second LAN, and any text with `AddressValueError`.
         * All three came out as a stack trace instead of something the LLM could
         * fix.
         */
        const needed = _REQUIRED_PREFIX[field_name];
        // strict=True like `IPPlanner`: if host bits were accepted here,
        // validation would pass and the planner would blow up later.
        let net;
        try {
            net = _parse_ipv4_network_strict(v);
        } catch (exc) {
            throw new Error(
                `'${v}' is not a valid IPv4 network (${exc.message}). Example: 192.168.0.0/16`
            );
        }
        if (net.prefixlen > needed) {
            throw new Error(
                `'${v}' is a /${net.prefixlen} and the subnets carved from it are /${needed}, ` +
                `so not even one fits. Use /${needed} or shorter ` +
                `(192.168.0.0/16 gives 256 /24 networks; 10.0.0.0/16 gives 16384 /30).`
            );
        }
        return v;
    }

    static _ipv6_pool_can_yield_subnets(v) {
        /** Same treatment for IPv6, from which the planner carves /64s. */
        let net;
        try {
            net = _parse_ipv6_network_strict(v);
        } catch (exc) {
            throw new Error(
                `'${v}' is not a valid IPv6 network (${exc.message}). Example: 2001:db8::/32`
            );
        }
        if (net.prefixlen > 64) {
            throw new Error(
                `'${v}' is a /${net.prefixlen} and the subnets carved from it are /64, ` +
                `so not even one fits. Use /64 or shorter (e.g. 2001:db8::/32).`
            );
        }
        return v;
    }

    toDict() {
        return {
            template: this.template, routers: this.routers,
            switches_per_router: this.switches_per_router,
            pcs_per_lan: Array.isArray(this.pcs_per_lan) ? [...this.pcs_per_lan] : this.pcs_per_lan,
            laptops_per_lan: Array.isArray(this.laptops_per_lan) ? [...this.laptops_per_lan] : this.laptops_per_lan,
            servers: this.servers, access_points: this.access_points, has_wan: this.has_wan,
            dhcp: this.dhcp, routing: this.routing, router_model: this.router_model,
            switch_model: this.switch_model, base_network: this.base_network,
            inter_router_network: this.inter_router_network, floating_routes: this.floating_routes,
            ospf_process_id: this.ospf_process_id, eigrp_as: this.eigrp_as, vlans: this.vlans,
            dual_stack: this.dual_stack, ipv6_base: this.ipv6_base,
            wireless_laptops: this.wireless_laptops, canvas_width: this.canvas_width,
            canvas_height: this.canvas_height,
        };
    }
}
