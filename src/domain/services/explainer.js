// Explainer: generates human-readable explanations of the plan's decisions.
//
// Useful for learning, and so the LLM can tell the user
// why each decision was made.

export function explain_plan(plan) {
    /** Generates a list of explanations for the plan's decisions. */
    const explanations = [];

    // Devices
    const routers = plan.devices_by_category("router");
    const switches = plan.devices_by_category("switch");
    const pcs = plan.devices_by_category("pc");
    const servers = plan.devices_by_category("server");
    const clouds = plan.devices_by_category("cloud");

    explanations.push(
        `Topology with ${routers.length} router(s), ${switches.length} switch(es), ` +
        `${pcs.length} PC(s), ${servers.length} server(s)` +
        (clouds.length ? " and a WAN connection" : "") + "."
    );

    // Subnetting
    const lan_subnets = new Set();
    const link_subnets = new Set();
    for (const dev of routers) {
        for (const [iface, ip] of Object.entries(dev.interfaces)) {
            void iface;
            const prefix = ip.split("/")[1];
            if (prefix === "24") {
                lan_subnets.add(ip.slice(0, ip.lastIndexOf(".")) + ".0/24");
            } else if (prefix === "30") {
                link_subnets.add(ip);
            }
        }
    }

    if (lan_subnets.size) {
        explanations.push(
            `${lan_subnets.size} /24 subnets were assigned to LANs — ` +
            "each LAN supports up to 254 hosts."
        );
    }
    if (link_subnets.size) {
        explanations.push(
            "Point-to-point links (router↔router, router↔WAN) use /30 subnets — " +
            "saving IP addresses with only 2 hosts per link."
        );
    }

    // Cables
    const cross_links = plan.links.filter((l) => l.cable === "cross");
    const straight_links = plan.links.filter((l) => l.cable === "straight");
    if (cross_links.length) {
        explanations.push(
            `${cross_links.length} crossover cable(s) are used between devices ` +
            "of the same type (router↔router, switch↔switch)."
        );
    }
    if (straight_links.length) {
        explanations.push(
            `${straight_links.length} straight-through cable(s) are used between devices ` +
            "of different types (router↔switch, switch↔PC)."
        );
    }

    // DHCP
    if (plan.dhcp_pools.length) {
        explanations.push(
            `${plan.dhcp_pools.length} DHCP pool(s) were configured — ` +
            "the PCs get their IP automatically."
        );
        for (const pool of plan.dhcp_pools) {
            explanations.push(
                `  Pool '${pool.pool_name}': network ${pool.network}/${pool.mask}, ` +
                `gateway ${pool.gateway}`
            );
        }
    }

    // Routing
    if (plan.static_routes.length) {
        const floating = plan.static_routes.filter((r) => r.admin_distance !== 1);
        const primary = plan.static_routes.filter((r) => r.admin_distance === 1);
        let msg = `${primary.length} static route(s) were configured — each router knows how to reach the other routers' LANs.`;
        if (floating.length) {
            msg += ` Plus ${floating.length} floating backup route(s) with AD=${floating[0].admin_distance}.`;
        }
        explanations.push(msg);
    }
    if (plan.ospf_configs.length) {
        explanations.push(
            `OSPF (process ${plan.ospf_configs[0].process_id}) was configured on ${plan.ospf_configs.length} router(s) — ` +
            "routes are learned dynamically through LSAs."
        );
    }
    if (plan.rip_configs.length) {
        explanations.push(
            `RIP v${plan.rip_configs[0].version} was configured on ${plan.rip_configs.length} router(s) — ` +
            "a distance-vector protocol, with no auto-summary enabled."
        );
    }
    if (plan.eigrp_configs.length) {
        explanations.push(
            `EIGRP (AS ${plan.eigrp_configs[0].as_number}) was configured on ${plan.eigrp_configs.length} router(s) — ` +
            "an advanced distance-vector protocol (Cisco) with fast convergence."
        );
    }

    // Validation
    if (plan.validations.length) {
        explanations.push(
            `Suggested checks: ${plan.validations.length} ` +
            `(e.g. ping ${plan.validations[0].from_device} → ${plan.validations[0].to_target})`
        );
    }

    return explanations;
}
