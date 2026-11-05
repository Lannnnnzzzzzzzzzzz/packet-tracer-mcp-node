// Estimator: generates estimates of what is going to be created (dry-run).
//
// Useful so the LLM or the user can see what is going to be done before
// generating scripts.

import { pyTruthy } from "../../shared/pycompat.js";

// Python request.routing.value: in JS the field holds the plain string already;
// accept an enum-like object too so both shapes work.
function _routing_value(request) {
    const r = request.routing;
    if (r !== null && typeof r === "object") return r.value;
    return r;
}

export function estimate_from_request(request) {
    /** Estimates resources without generating the full plan. */
    const total_pcs = _normalized_total(request.pcs_per_lan, request.routers);
    const total_laptops = _normalized_total(request.laptops_per_lan, request.routers);
    const total_access_points = Math.min(request.access_points, request.routers);

    const total_switches = request.routers * request.switches_per_router;
    let total_devices = (
        request.routers
        + total_switches
        + total_pcs
        + total_laptops
        + total_access_points
        + request.servers
    );
    if (pyTruthy(request.has_wan)) {
        total_devices += 1;
    }

    // Estimated links
    const router_links = Math.max(0, request.routers - 1);  // chain
    const router_switch_links = total_switches;
    const switch_pc_links = total_pcs;
    const switch_laptop_links = total_laptops;
    const switch_ap_links = total_access_points;
    const server_links = request.servers;
    const wan_link = request.has_wan ? 1 : 0;
    const total_links = (
        router_links
        + router_switch_links
        + switch_pc_links
        + switch_laptop_links
        + switch_ap_links
        + server_links
        + wan_link
    );

    const routing = _routing_value(request);
    return {
        "devices": {
            "routers": request.routers,
            "switches": total_switches,
            "pcs": total_pcs,
            "laptops": total_laptops,
            "access_points": total_access_points,
            "servers": request.servers,
            "clouds": request.has_wan ? 1 : 0,
            "total": total_devices,
        },
        "links": {
            "router_to_router": router_links,
            "router_to_switch": router_switch_links,
            "switch_to_pc": switch_pc_links,
            "switch_to_laptop": switch_laptop_links,
            "switch_to_access_point": switch_ap_links,
            "switch_to_server": server_links,
            "router_to_cloud": wan_link,
            "total": total_links,
        },
        "configs": {
            "routers_to_configure": request.routers,
            "dhcp_pools": request.dhcp ? request.routers : 0,
            "static_routes": routing === "static" ? router_links * 2 : 0,
            "ospf_configs": routing === "ospf" ? request.routers : 0,
            "rip_configs": routing === "rip" ? request.routers : 0,
            "eigrp_configs": routing === "eigrp" ? request.routers : 0,
            "floating_routes": (pyTruthy(request.floating_routes) && routing === "static") ? "yes (backup via alternate paths)" : "no",
        },
        "subnets": {
            "lan_subnets": request.routers,
            "link_subnets": router_links + wan_link,
        },
        "complexity": _estimate_complexity(request),
    };
}

export function estimate_from_plan(plan) {
    /** Estimates resources from a plan that has already been generated. */
    return {
        "devices_to_create": plan.devices.length,
        "links_to_create": plan.links.length,
        "configs_to_generate": plan.devices.filter((d) => ["router", "switch"].includes(d.category)).length,
        "dhcp_pools": plan.dhcp_pools.length,
        "static_routes": plan.static_routes.length,
        "ospf_configs": plan.ospf_configs.length,
        "rip_configs": plan.rip_configs.length,
        "eigrp_configs": plan.eigrp_configs.length,
        "validations": plan.validations.length,
        "has_errors": !pyTruthy(plan.is_valid),
        "error_count": plan.errors.length,
    };
}

function _estimate_complexity(req) {
    const routing = _routing_value(req);
    let score = req.routers * 3 + (
        Array.isArray(req.pcs_per_lan) ? req.pcs_per_lan.reduce((a, b) => a + b, 0) : req.pcs_per_lan * req.routers
    ) + (
        Array.isArray(req.laptops_per_lan) ? req.laptops_per_lan.reduce((a, b) => a + b, 0) : req.laptops_per_lan * req.routers
    ) + req.servers * 2 + Math.min(req.access_points, req.routers);
    if (pyTruthy(req.has_wan)) {
        score += 5;
    }
    if (routing === "ospf") {
        score += 10;
    } else if (routing === "eigrp" || routing === "rip") {
        score += 8;
    }
    if (pyTruthy(req.floating_routes)) {
        score += 5;
    }

    if (score <= 10) {
        return "simple";
    } else if (score <= 25) {
        return "moderate";
    } else if (score <= 50) {
        return "complex";
    }
    return "very complex";
}

function _normalized_total(values, routers) {
    /** Normalizes an int/list per router using the same convention as the orchestrator. */
    if (typeof values === "number" && Number.isInteger(values)) {
        return values * routers;
    }

    const normalized = values.slice(0, routers);
    while (normalized.length < routers) {
        normalized.push(normalized.length ? normalized[normalized.length - 1] : 0);
    }
    return normalized.reduce((a, b) => a + b, 0);
}
