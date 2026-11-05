// Main orchestrator.
//
// Translates a TopologyRequest into a complete TopologyPlan
// with devices, links, IPs, DHCP and routes, all validated.

import { TopologyPlan, DevicePlan, LinkPlan, ModulePlan, ValidationCheck } from "../models/plans.js";
import { VLANConfig, AccessPortConfig, TrunkConfig } from "../models/vlans.js";
import { IPPlanner } from "./ip_planner.js";
import { validate_plan } from "./validator.js";
import { resolve_model, get_ports_by_speed } from "../../infrastructure/catalog/devices.js";
import { infer_cable } from "../../infrastructure/catalog/cables.js";
import { get_template } from "../../infrastructure/catalog/templates.js";
import { get_serial_module, ports_for_slot } from "../../infrastructure/catalog/modules.js";
import { layout } from "./layout.js";
import { PortSpeed, DeviceRole, TopologyTemplate } from "../../shared/enums.js";
import {
    DEFAULT_ROUTER, DEFAULT_SWITCH,
    LAYOUT_X_START, LAYOUT_Y_ROUTER, LAYOUT_Y_SWITCH, LAYOUT_Y_PC,
    LAYOUT_X_SPACING, LAYOUT_PC_X_SPACING, LAYOUT_CLOUD_X_OFFSET,
} from "../../shared/constants.js";
import { pyFloorDiv, pyTruthy } from "../../shared/pycompat.js";

export function plan_from_request(request) {
    /**
     * Full pipeline. Returns [plan, validation_result] (Python tuple).
     */
    const plan = new TopologyPlan();

    // Respect the template's constraints (e.g. router_on_a_stick and star are
    // 1 router by definition). Clamp so the default routers=2 does not break the shape.
    try {
        const spec = get_template(request.template);
        request.routers = Math.max(spec.min_routers, Math.min(request.routers, spec.max_routers));
    } catch {
        // Python: except Exception: pass
    }

    const pcs_list = _normalize_pcs(request);
    const laptops_list = _normalize_laptops(request);

    _create_devices(plan, request, pcs_list, laptops_list);
    _create_links(plan, request, pcs_list, laptops_list);
    _assign_wifi_aps(plan, request, laptops_list);
    _apply_layout(plan, request, laptops_list);
    _create_vlans(plan, request);

    const ip_planner = new IPPlanner(
        request.base_network,
        request.inter_router_network,
    );
    ip_planner.plan_addressing(
        plan,
        request.routing,
        request.dhcp,
        request.floating_routes,
        request.ospf_process_id,
        request.eigrp_as,
        request.dual_stack,
        request.ipv6_base,
    );

    _create_validations(plan);

    const layout_notes = plan.warnings.filter((w) => w.startsWith("Layout: ") || w.startsWith("Planner: "));
    const result = validate_plan(plan);
    // validate_plan rewrites plan.warnings from its own result; keep the planner's.
    for (const w of layout_notes) {
        if (!plan.warnings.includes(w)) plan.warnings.push(w);
    }
    return [plan, result];
}

function _normalize_pcs(req) {
    if (typeof req.pcs_per_lan === "number" && Number.isInteger(req.pcs_per_lan)) {
        return Array(req.routers).fill(req.pcs_per_lan);
    }
    const pcs = [...req.pcs_per_lan];
    while (pcs.length < req.routers) {
        pcs.push(pcs.length ? pcs[pcs.length - 1] : 3);
    }
    return pcs;
}

function _normalize_laptops(req) {
    if (typeof req.laptops_per_lan === "number" && Number.isInteger(req.laptops_per_lan)) {
        return Array(req.routers).fill(req.laptops_per_lan);
    }
    const laptops = [...req.laptops_per_lan];
    while (laptops.length < req.routers) {
        laptops.push(laptops.length ? laptops[laptops.length - 1] : 0);
    }
    return laptops;
}

function _wifi_lan_indices(req, laptops_list) {
    /** LANs that need their own AP: those that have wireless laptops.
     *
     * Previously ONE single AP was created for the whole topology, cabled to the switch
     * of the first LAN. Since in the logical view the RF range is global, the laptops of
     * ALL LANs associated with that AP and ended up with an IP from the LAN 1 DHCP pool
     * -- verified against PT 9.0.1: LT9, planned for LAN 5, received 192.168.0.5/24. One
     * AP per LAN puts each laptop on the subnet it belongs to.
     */
    if (!pyTruthy(req.wireless_laptops) || pyTruthy(req.access_points)) {
        return [];
    }
    const out = [];
    for (let i = 0; i < req.routers; i++) {
        if (laptops_list[i] > 0) out.push(i);
    }
    return out;
}

function _layout_metrics(req, pcs_list, laptops_list) {
    /** [initial x, column width] so that no LAN overflows or overlaps another.
     *
     * The fixed 250 px width was enough for 3 hosts per LAN. With 4, the cluster
     * (4 x 80 = 320) overflowed its column and spilled into the neighboring LAN, and since
     * the cluster is centered, the first host fell at x=-60: outside the canvas.
     * Returns [x_start, column_width] (Python tuple).
     */
    const per_lan = pcs_list.map((p, i) => Math.max(p, laptops_list[i]));
    const widest = per_lan.length ? Math.max(...per_lan) : 0;
    const column_width = Math.max(LAYOUT_X_SPACING, widest * LAYOUT_PC_X_SPACING);
    // The cluster is centered on its column, so it extends half its width to the
    // left: the origin has to leave that margin. The servers share the LAN 1 column,
    // so they count too.
    const left_reach = pyFloorDiv(Math.max(widest, req.servers) * LAYOUT_PC_X_SPACING, 2);
    return [Math.max(LAYOUT_X_START, left_reach), column_width];
}

function _create_devices(plan, req, pcs_list, laptops_list) {
    const router_model = req.router_model || DEFAULT_ROUTER;
    const switch_model = req.switch_model || DEFAULT_SWITCH;
    const [x_start, column_width] = _layout_metrics(req, pcs_list, laptops_list);

    const _column_x = (lan_index) => {
        /** Center of the column of LAN `lan_index`. */
        return x_start + lan_index * column_width;
    };

    const _row_x = (centre, count, index) => {
        /** x of host `index` in a row of `count`, centered on `centre`. */
        return centre - pyFloorDiv(count * LAYOUT_PC_X_SPACING, 2) + index * LAYOUT_PC_X_SPACING;
    };

    // Own row for the APs: hung off the switch without overlapping it or the
    // secondary switches, which are shifted 120 px at a time along the same row.
    const ap_y = LAYOUT_Y_SWITCH + 70;

    // These row-by-row positions are provisional: _apply_layout replaces them with the
    // topology-aware layout once the links exist.
    for (let i = 0; i < req.routers; i++) {
        const role = req.routers === 1 ? DeviceRole.CORE_ROUTER : (
            (i === 0 || i === req.routers - 1) ? DeviceRole.EDGE_ROUTER : DeviceRole.CORE_ROUTER
        );
        plan.devices.push(new DevicePlan({
            name: `R${i + 1}`, model: router_model, category: "router",
            role: role, x: _column_x(i), y: LAYOUT_Y_ROUTER,
        }));
    }

    // Switches + PCs + Laptops
    let switch_idx = 0;
    let pc_idx = 0;
    let laptop_idx = 0;
    for (let i = 0; i < req.routers; i++) {
        for (let s = 0; s < req.switches_per_router; s++) {
            switch_idx += 1;
            plan.devices.push(new DevicePlan({
                name: `SW${switch_idx}`, model: switch_model, category: "switch",
                role: DeviceRole.ACCESS_SWITCH,
                x: _column_x(i) + s * 120, y: LAYOUT_Y_SWITCH,
            }));
            if (s === 0) {
                const n_pcs = pcs_list[i];
                for (let p = 0; p < n_pcs; p++) {
                    pc_idx += 1;
                    plan.devices.push(new DevicePlan({
                        name: `PC${pc_idx}`, model: "PC-PT", category: "pc",
                        role: DeviceRole.END_HOST,
                        x: _row_x(_column_x(i), n_pcs, p),
                        y: LAYOUT_Y_PC,
                    }));
                }
                const n_laptops = laptops_list[i];
                for (let l = 0; l < n_laptops; l++) {
                    laptop_idx += 1;
                    plan.devices.push(new DevicePlan({
                        name: `LT${laptop_idx}`, model: "Laptop-PT", category: "laptop",
                        role: DeviceRole.END_HOST,
                        wireless: req.wireless_laptops,
                        x: _row_x(_column_x(i), n_laptops, l),
                        y: LAYOUT_Y_PC + 80,
                    }));
                }
            }
        }
    }

    // WiFi: one AP per LAN that has wireless laptops. Each one is cabled to the switch
    // of ITS LAN in _create_links, which is what puts those laptops on the
    // correct subnet.
    _wifi_lan_indices(req, laptops_list).forEach((lan, k) => {
        plan.devices.push(new DevicePlan({
            name: `WAP${k + 1}`, model: "AccessPoint-PT", category: "accesspoint",
            role: DeviceRole.END_HOST, x: _column_x(lan), y: ap_y,
        }));
    });

    // APs requested explicitly — one per primary switch of each router
    if (req.access_points > 0) {
        for (let i = 0; i < Math.min(req.access_points, req.routers); i++) {
            plan.devices.push(new DevicePlan({
                name: `AP${i + 1}`, model: "AccessPoint-PT", category: "accesspoint",
                role: DeviceRole.END_HOST,
                x: _column_x(i), y: ap_y,
            }));
        }
    }

    // Servers — in the column of the switch they are cabled to (the first one) and in their
    // own row. They used to be sent to the far right of the diagram while the cable still went
    // to SW1, drawing diagonals from end to end.
    for (let i = 0; i < req.servers; i++) {
        plan.devices.push(new DevicePlan({
            name: `SRV${i + 1}`, model: "Server-PT", category: "server",
            role: DeviceRole.SERVER_HOST,
            x: _row_x(_column_x(0), req.servers, i),
            y: LAYOUT_Y_PC + 240,
        }));
    }

    // Cloud / WAN
    if (pyTruthy(req.has_wan)) {
        plan.devices.push(new DevicePlan({
            name: "WAN", model: "Cloud-PT", category: "cloud",
            role: DeviceRole.WAN_CLOUD,
            x: x_start + req.routers * column_width + LAYOUT_CLOUD_X_OFFSET,
            y: LAYOUT_Y_ROUTER,
        }));
    }
}

function _assign_wifi_aps(plan, req, laptops_list) {
    /** Record on each WiFi laptop the AP of its LAN (DevicePlan.ap). */
    if (!pyTruthy(req.wireless_laptops)) {
        return;
    }
    const by_name = {};
    for (const d of plan.devices) by_name[d.name] = d;
    const wifi_aps = {};
    _wifi_lan_indices(req, laptops_list).forEach((lan, k) => {
        wifi_aps[lan] = `WAP${k + 1}`;
    });
    let lt = 0;
    laptops_list.forEach((count, lan) => {
        for (let j = 0; j < count; j++) {
            lt += 1;
            const dev = by_name[`LT${lt}`];
            if (!dev || !pyTruthy(dev.wireless)) {
                continue;
            }
            for (const parent of [wifi_aps[lan], `AP${lan + 1}`]) {
                if (pyTruthy(parent) && by_name[parent] && by_name[parent].category === "accesspoint") {
                    dev.ap = parent;
                    break;
                }
            }
        }
    });
}

function _apply_layout(plan, req, laptops_list) {
    /** Replace the row-by-row positions with the topology-aware layout (layout.py).
     *
     * WiFi laptops have no cable, so they are attached to the AP of their LAN (or its
     * switch) for drawing only.
     */
    void laptops_list;
    const attach = {};
    for (const d of plan.devices) {
        if (pyTruthy(d.wireless) && pyTruthy(d.ap)) attach[d.name] = d.ap;
    }
    const canvas = (pyTruthy(req.canvas_width) && pyTruthy(req.canvas_height))
        ? [req.canvas_width, req.canvas_height] : null;
    plan.warnings = plan.warnings.filter((w) => !w.startsWith("Layout: "));
    const res = layout(plan.devices.map((d) => [d.name, d.category]),
                 plan.links.map((l) => [l.device_a, l.device_b]), canvas, attach);
    for (const d of plan.devices) {
        if (Object.prototype.hasOwnProperty.call(res.positions, d.name)) {
            d.x = res.positions[d.name][0];
            d.y = res.positions[d.name][1];
        }
    }
    for (const n of res.notes) plan.warnings.push(`Layout: ${n}`);
}

export function fit_plan_to_canvas(plan, req, canvas) {
    /** Lay `plan` out again for a `canvas` (width, height) read after planning. */
    req.canvas_width = canvas[0];
    req.canvas_height = canvas[1];
    _apply_layout(plan, req, _normalize_laptops(req));
}

function _create_links(plan, req, pcs_list, laptops_list) {
    const router_model_obj = resolve_model(req.router_model || DEFAULT_ROUTER);
    const switch_model_obj = resolve_model(req.switch_model || DEFAULT_SWITCH);
    if (!router_model_obj || !switch_model_obj) {
        plan.errors.push("Invalid router or switch model");
        return;
    }

    const routers = plan.devices_by_category("router");
    const switches = plan.devices_by_category("switch");
    const pcs = plan.devices_by_category("pc");
    const laptops = plan.devices_by_category("laptop");
    const aps = plan.devices_by_category("accesspoint");
    const servers = plan.devices_by_category("server");
    const cloud = plan.devices.find((d) => d.category === "cloud") ?? null;

    const used = {};
    for (const d of plan.devices) used[d.name] = [];

    const _next_port = (name, model, speed) => {
        const m = resolve_model(model);
        if (!m) {
            return null;
        }
        for (const p of get_ports_by_speed(m, speed)) {
            if (!used[name].includes(p.full_name)) {
                used[name].push(p.full_name);
                return p.full_name;
            }
        }
        return null;
    };

    const _gig = (name, model) => _next_port(name, model, PortSpeed.GIGABIT_ETHERNET);
    const _fast = (name, model) => _next_port(name, model, PortSpeed.FAST_ETHERNET);

    const _router_port = (name, model) => {
        /** Gigabit first; a router with only FastEthernet (the 2811) falls back to it. */
        return _gig(name, model) || _fast(name, model);
    };

    const _access_port = (name, model) => {
        /** FastEthernet first; a switch without it (the 3650) falls back to Gigabit. */
        return _fast(name, model) || _gig(name, model);
    };

    const _ether = (name, model) => {
        /** Plain Ethernet port — the cloud's is Ethernet6, not FastEthernet. */
        return _next_port(name, model, PortSpeed.ETHERNET);
    };

    // Router ↔ Router — the SHAPE depends on the template (it used to always be a chain, which
    // meant three_router_triangle lacked the R3↔R1 closing link = no redundancy).
    let edges;
    if (req.template === TopologyTemplate.HUB_SPOKE && routers.length >= 2) {
        // Router star: R1 (hub) ↔ each spoke.
        edges = routers.slice(1).map((spoke) => [routers[0], spoke]);
    } else {
        // Chain: R[i] ↔ R[i+1].
        edges = [];
        for (let i = 0; i < routers.length - 1; i++) edges.push([routers[i], routers[i + 1]]);
        // Triangle/ring: closes the last ↔ the first to provide the redundant path.
        if (req.template === TopologyTemplate.THREE_ROUTER_TRIANGLE && routers.length >= 3) {
            edges.push([routers[routers.length - 1], routers[0]]);
        }
    }

    // Each router keeps an Ethernet port for every LAN switch and for the WAN cloud.
    // A router-router link that would eat one of those goes over serial instead: an
    // HWIC-2T / NIM-2T is added to the plan. Without this a hub with 3 spokes on a
    // 2911 (3 Gigabit ports) left its own LAN unconnected, and a triangle with WAN
    // dropped the cloud, both silently.
    const spr = req.switches_per_router;
    const eth_free = {};
    for (const r of routers) {
        eth_free[r.name] = _ethernet_ports(r.model).length - spr
            - ((cloud && r === routers[routers.length - 1]) ? 1 : 0);
    }
    const serial = new _SerialPorts(plan);

    const _link_routers = (ra, rb) => {
        if (eth_free[ra.name] > 0 && eth_free[rb.name] > 0) {
            const p1 = _router_port(ra.name, ra.model);
            const p2 = _router_port(rb.name, rb.model);
            if (p1 && p2) {
                eth_free[ra.name] -= 1;
                eth_free[rb.name] -= 1;
                plan.links.push(new LinkPlan({
                    device_a: ra.name, port_a: p1,
                    device_b: rb.name, port_b: p2,
                    cable: infer_cable("router", "router"),
                }));
                return;
            }
        }
        const s1 = serial.port(ra);
        const s2 = serial.port(rb);
        if (s1 && s2) {
            plan.links.push(new LinkPlan({ device_a: ra.name, port_a: s1,
                                       device_b: rb.name, port_b: s2, cable: "serial" }));
        } else {
            plan.warnings.push(
                `Planner: no free port for ${ra.name} <-> ${rb.name} (${ra.model}/${rb.model} have no ` +
                "Ethernet left and no serial slot): the link was left out. Use a router with more " +
                "ports (ISR4331, 2911) or fewer links."
            );
        }
    };

    for (const [ra, rb] of edges) {
        _link_routers(ra, rb);
    }

    // Router ↔ Switch
    for (let i = 0; i < routers.length; i++) {
        const router = routers[i];
        for (const sw of switches.slice(i * spr, (i + 1) * spr)) {
            const rp = _router_port(router.name, router.model);
            const sp = _gig(sw.name, sw.model);
            if (rp && sp) {
                plan.links.push(new LinkPlan({
                    device_a: router.name, port_a: rp,
                    device_b: sw.name, port_b: sp,
                    cable: infer_cable("router", "switch"),
                }));
            }
        }
    }

    // Switch ↔ PCs
    let pc_idx = 0;
    for (let i = 0; i < req.routers; i++) {
        const primary_sw = (i * spr < switches.length) ? switches[i * spr] : null;
        if (!primary_sw) {
            continue;
        }
        for (let j = 0; j < pcs_list[i]; j++) {
            if (pc_idx >= pcs.length) {
                break;
            }
            const pc = pcs[pc_idx];
            const sp = _access_port(primary_sw.name, primary_sw.model);
            const pp = _fast(pc.name, pc.model);
            if (sp && pp) {
                plan.links.push(new LinkPlan({
                    device_a: primary_sw.name, port_a: sp,
                    device_b: pc.name, port_b: pp,
                    cable: infer_cable("switch", "pc"),
                }));
            }
            pc_idx += 1;
        }
    }

    // Switch ↔ Laptops
    let laptop_idx = 0;
    for (let i = 0; i < req.routers; i++) {
        const primary_sw = (i * spr < switches.length) ? switches[i * spr] : null;
        if (!primary_sw) {
            continue;
        }
        for (let j = 0; j < laptops_list[i]; j++) {
            if (laptop_idx >= laptops.length) {
                break;
            }
            const lt = laptops[laptop_idx];
            laptop_idx += 1;
            if (pyTruthy(lt.wireless)) {
                // WiFi: association is over RF (automatic to an AP on the default SSID), not by cable.
                continue;
            }
            const sp = _access_port(primary_sw.name, primary_sw.model);
            const lp = _fast(lt.name, lt.model);
            if (sp && lp) {
                plan.links.push(new LinkPlan({
                    device_a: primary_sw.name, port_a: sp,
                    device_b: lt.name, port_b: lp,
                    cable: infer_cable("switch", "pc"),
                }));
            }
        }
    }

    // Switch ↔ Access Points — each AP to the switch of ITS LAN.
    //
    // With a single AP this did not matter: it went to the first switch and that was it. Now the
    // automatic APs exist only for the LANs that have WiFi laptops, so the AP index does not
    // match the LAN index and it has to be mapped.
    const wifi_lans = _wifi_lan_indices(req, laptops_list);
    let ap_to_lan;
    if (wifi_lans.length) {
        ap_to_lan = wifi_lans.map((lan, k) => [k, lan]);
    } else {
        ap_to_lan = [];
        for (let k = 0; k < Math.min(req.access_points, req.routers); k++) ap_to_lan.push([k, k]);
    }

    for (const [ap_idx, lan] of ap_to_lan) {
        if (ap_idx >= aps.length) {
            break;
        }
        const primary_sw = (lan * spr < switches.length) ? switches[lan * spr] : null;
        if (!primary_sw) {
            continue;
        }
        const ap = aps[ap_idx];
        const sp = _access_port(primary_sw.name, primary_sw.model);
        const ap_port = _fast(ap.name, ap.model);
        if (sp && ap_port) {
            plan.links.push(new LinkPlan({
                device_a: primary_sw.name, port_a: sp,
                device_b: ap.name, port_b: ap_port,
                cable: infer_cable("switch", "pc"),
            }));
        }
    }

    // Switch ↔ Servers
    if (servers.length && switches.length) {
        const sw = switches[0];
        for (const srv of servers) {
            const sp = _access_port(sw.name, sw.model);
            const srp = _fast(srv.name, srv.model);
            if (sp && srp) {
                plan.links.push(new LinkPlan({
                    device_a: sw.name, port_a: sp,
                    device_b: srv.name, port_b: srp,
                    cable: infer_cable("switch", "server"),
                }));
            }
        }
    }

    // Router ↔ Cloud
    if (cloud && routers.length) {
        const last = routers[routers.length - 1];
        const rp = _router_port(last.name, last.model);
        const cp = _ether(cloud.name, cloud.model);
        if (rp && cp) {
            plan.links.push(new LinkPlan({
                device_a: last.name, port_a: rp,
                device_b: cloud.name, port_b: cp,
                cable: infer_cable("router", "cloud"),
            }));
        }
    }
}

// Free slots for a 2-port serial card, in install order, per router model. HWIC on
// 1941 / 2901 / 2911, NIM on the ISR 4000 (slot "0/1" measured; the rest follow PT's
// chassis/subslot naming).
const _SERIAL_SLOTS = {
    "1941": ["0/0", "0/1"],
    "2901": ["0/0", "0/1", "0/2", "0/3"],
    "2911": ["0/0", "0/1", "0/2", "0/3"],
    "ISR4321": ["0/1", "0/2"],
    "ISR4331": ["0/1", "0/2", "0/3"],
};

function _ethernet_ports(model) {
    /** Routed Ethernet ports of a router model (Gigabit, else FastEthernet). */
    const m = resolve_model(model);
    if (!m) {
        return [];
    }
    const gig = get_ports_by_speed(m, PortSpeed.GIGABIT_ETHERNET).map((p) => p.full_name);
    if (gig.length) return gig;
    return get_ports_by_speed(m, PortSpeed.FAST_ETHERNET).map((p) => p.full_name);
}

class _SerialPorts {
    /** Hands out serial ports, adding a 2-port serial module to the plan when needed. */

    constructor(plan) {
        this.plan = plan;
        this.free = {};
        this.slots_used = {};
    }

    port(router) {
        const free = Object.prototype.hasOwnProperty.call(this.free, router.name)
            ? this.free[router.name] : (this.free[router.name] = []);
        if (!free.length) {
            const spec = get_serial_module(router.model);
            const slots = _SERIAL_SLOTS[router.model] ?? [];
            const used = this.slots_used[router.name] ?? 0;
            if (!spec || used >= slots.length) {
                return null;
            }
            const slot = slots[used];
            this.slots_used[router.name] = used + 1;
            this.plan.modules.push(new ModulePlan({ device: router.name, slot: slot, module: spec.name }));
            free.push(...ports_for_slot(spec, slot));
        }
        return free.shift();
    }
}

function _switch_port_for(plan, switch_name, peer_name) {
    /** Switch port on the switch↔peer link (or None if there is no link). */
    for (const link of plan.links) {
        if (link.device_a === switch_name && link.device_b === peer_name) {
            return link.port_a;
        }
        if (link.device_b === switch_name && link.device_a === peer_name) {
            return link.port_b;
        }
    }
    return null;
}

function _create_vlans(plan, req) {
    /** ROUTER_ON_A_STICK: turns the single LAN into N VLANs with inter-VLAN routing.
     *
     * The physical topology (1 router ↔ 1 switch via trunk, switch ↔ PCs via access) is already
     * created by _create_links; here we add the logical layer: declare VLANs, mark the switch
     * uplink as trunk, assign each PC to an access VLAN and set DevicePlan.vlan. The IP
     * planner does the per-VLAN subnetting and creates the router's .1q subinterfaces.
     */
    if (req.template !== TopologyTemplate.ROUTER_ON_A_STICK) {
        return;
    }
    const routers = plan.devices_by_category("router");
    const switches = plan.devices_by_category("switch");
    const pcs = plan.devices_by_category("pc");
    if (!routers.length || !switches.length || !pcs.length) {
        return;
    }
    const router = routers[0], sw = switches[0];

    let vlan_count = (pyTruthy(req.vlans) && req.vlans > 0) ? req.vlans : 2;
    vlan_count = Math.max(1, Math.min(vlan_count, pcs.length));  // no more VLANs than PCs
    const vlan_ids = Array.from({ length: vlan_count }, (_, i) => 10 * (i + 1));
    plan.vlans = vlan_ids.map((v) => new VLANConfig({ vlan_id: v, name: `VLAN${v}` }));

    pcs.forEach((pc, idx) => {
        const vid = vlan_ids[idx % vlan_count];
        pc.vlan = vid;
        const sw_port = _switch_port_for(plan, sw.name, pc.name);
        if (pyTruthy(sw_port)) {
            plan.access_ports.push(
                new AccessPortConfig({ switch: sw.name, port: sw_port, vlan_id: vid })
            );
        }
    });

    const trunk_port = _switch_port_for(plan, sw.name, router.name);
    if (pyTruthy(trunk_port)) {
        plan.trunks.push(
            new TrunkConfig({ switch: sw.name, port: trunk_port, allowed_vlans: vlan_ids })
        );
    }
}

function _create_validations(plan) {
    const pcs = plan.devices_by_category("pc");
    if (pcs.length >= 2) {
        plan.validations.push(new ValidationCheck({
            check_type: "ping", from_device: pcs[0].name,
            to_target: pcs[pcs.length - 1].name, expected: "Reply",
        }));
    }
}
