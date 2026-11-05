// Rules about the SHAPE of the graph and the consistency of the routing.
//
// The other rules check devices, ports and IPs one at a time. These two check the
// whole plan, which is where the worst silent failure of the pipeline was hiding:
//
// `hub_spoke` asks for the hub to be linked to each spoke, but a 2911 has three
// Gigabit ports. With six routers the hub runs out of ports by the fourth link, and
// `_link_routers` simply did not create the link — without any warning. The result
// was a plan with two loose routers, no interfaces, no links and an OSPF with
// `router-id 0.0.0.0` and zero networks... which the validator approved with `valid=true`.
//
// A topology split into islands looks identical to a healthy one in every per-device
// check: each device exists, each port is valid, no IP clashes. The only thing that
// gives it away is walking the graph.

import { PlanError, ErrorCode } from "../models/errors.js";
import { pyTruthy } from "../../shared/pycompat.js";

export function validate_connectivity(plan) {
    /** Checks that all wired devices form ONE single connected component.
     *
     * WiFi laptops are left out of the graph on purpose: they have no cable because
     * they associate over RF, so counting them as islands would flag every wireless
     * topology as broken.
     */
    const wired = plan.devices.filter((d) => !d.wireless);
    if (wired.length <= 1) {
        // Zero or one device is, trivially, a single component.
        return [];
    }

    const names = new Set(wired.map((d) => d.name));
    const adjacency = {};
    for (const name of names) adjacency[name] = new Set();
    for (const link of plan.links) {
        if (names.has(link.device_a) && names.has(link.device_b)) {
            adjacency[link.device_a].add(link.device_b);
            adjacency[link.device_b].add(link.device_a);
        }
    }

    // BFS from the first device: anything not reached is another island.
    const start = wired[0].name;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
        const current = queue.pop();
        for (const neighbour of adjacency[current]) {
            if (!seen.has(neighbour)) {
                seen.add(neighbour);
                queue.push(neighbour);
            }
        }
    }

    const unreachable = wired.filter((d) => !seen.has(d.name));
    if (!unreachable.length) {
        return [];
    }

    const orphan_names = unreachable.map((d) => d.name).join(", ");

    // A router with NO interfaces assigned is the signature of a hub that ran out
    // of ports: the IP planner only addresses what is linked.
    const starved = unreachable.filter((d) => d.category === "router" && !pyTruthy(d.interfaces));
    let suggestion;
    if (starved.length) {
        suggestion = (
            "The hub router ran out of free ports for that many " +
            "links. Use a model with more ports, add an expansion " +
            "module, or reduce the number of routers."
        );
    } else {
        suggestion = (
            `Add a link connecting ${unreachable[0].name} to the rest ` +
            "of the topology."
        );
    }

    return [new PlanError({
        code: ErrorCode.TOPOLOGY_DISCONNECTED,
        device: unreachable[0].name,
        message: (
            `The topology is split: ${orphan_names} has/have no path to ` +
            `${start}. Isolated devices can neither route nor receive traffic.`
        ),
        suggestion: suggestion,
    })];
}

export function validate_routing(plan) {
    /** Basic consistency of the declared OSPF processes.
     *
     * A router the planner could not assign interfaces to ends up with a `router ospf`
     * without networks and with `router-id 0.0.0.0`. Both are invalid config in IOS,
     * and both left the pipeline without a single complaint.
     */
    const errors = [];

    for (const cfg of plan.ospf_configs) {
        if (!pyTruthy(cfg.networks)) {
            errors.push(new PlanError({
                code: ErrorCode.OSPF_NO_NETWORKS,
                device: cfg.router,
                message: (
                    `OSPF process ${cfg.process_id} on ${cfg.router} advertises ` +
                    "no network."
                ),
                suggestion: (
                    "An OSPF process without `network` statements forms no " +
                    "adjacencies. Check that the router has addressed and " +
                    "linked interfaces."
                ),
            }));
        }

        // An empty `router_id` is legitimate: IOS picks the highest IP. What is not
        // legitimate is 0.0.0.0, which is what remains when there is no interface.
        if (cfg.router_id.trim() === "0.0.0.0") {
            errors.push(new PlanError({
                code: ErrorCode.OSPF_INVALID_ROUTER_ID,
                device: cfg.router,
                message: (
                    `OSPF on ${cfg.router} has router-id 0.0.0.0, which IOS ` +
                    "rejects."
                ),
                suggestion: (
                    "The router-id is derived from the router's interfaces; " +
                    "0.0.0.0 means none of them is addressed."
                ),
            }));
        }
    }

    return errors;
}

export function validate_wireless(plan) {
    /** Warns when a WiFi client's AP is not known. Returns WARNINGS.
     *
     * Every AccessPoint-PT broadcasts "Default" and PT does not pick the nearest one:
     * with one AP per LAN, LT3 and LT4 of LAN 2 leased 192.168.0.x from LAN 1 (measured
     * on PT 9.0.1, 2026-11-03). The client side cannot be pointed at an SSID (its
     * profile API throws), but the AP side can filter: pt_live_deploy gives every AP a
     * MAC filter that allows only the clients whose DevicePlan.ap names it, and the
     * laptops then lease from their own LAN (measured). The planner fills `ap` for the
     * laptops it creates; a hand-written plan with several APs needs it on each client.
     */
    const aps = new Set(plan.devices_by_category("accesspoint").map((d) => d.name));
    const wireless_hosts = plan.devices.filter((d) => d.wireless);
    if (aps.size < 2 || !wireless_hosts.length) {
        return [];
    }
    const unpinned = wireless_hosts.filter((d) => !aps.has(d.ap ?? "")).map((d) => d.name);
    if (!unpinned.length) {
        return [];
    }

    return [new PlanError({
        code: ErrorCode.WIRELESS_AMBIGUOUS_ASSOCIATION,
        device: unpinned[0],
        message: (
            `${aps.size} access points share the default SSID and ${unpinned.length} wireless ` +
            `host(s) have no \`ap\` (${unpinned.slice(0, 5).join(", ")}): PT lets each one join ANY AP ` +
            "and lease from another LAN's pool."
        ),
        suggestion: (
            'Set "ap": "<AP name>" on each wireless device: the deploy then gives every AP a ' +
            "MAC filter allowing only its own clients. On a live canvas, the same by hand: " +
            "pt_wireless_ap(device, mac_filter=True, allow_listed=True, mac_list=[their Wireless0 MACs])."
        ),
    })];
}
