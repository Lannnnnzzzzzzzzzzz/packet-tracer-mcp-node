// Plan models — the validated, complete result.

import { DeviceRole } from "../../shared/enums.js";
import { VLANConfig, AccessPortConfig, TrunkConfig, SubinterfaceConfig } from "./vlans.js";

function _wrap(cls, v) {
    if (v === null || v === undefined) return v;
    return v instanceof cls ? v : new cls(v);
}
function _wrapList(cls, v) { return (v || []).map((x) => _wrap(cls, x)); }
function _dict(v) { return v && typeof v.toDict === "function" ? v.toDict() : v; }
function _dictList(v) { return (v || []).map(_dict); }
function _int(v) { return typeof v === "string" ? parseInt(v, 10) : v; }
function _copyDictOfLists(v) {
    const out = {};
    for (const [k, val] of Object.entries(v || {})) out[k] = Array.isArray(val) ? [...val] : val;
    return out;
}

export class DevicePlan {
    /** A concrete device in the plan. */
    constructor(obj = {}) {
        this.name = obj.name !== undefined ? obj.name : undefined;
        this.model = obj.model !== undefined ? obj.model : undefined;
        this.category = obj.category !== undefined ? obj.category : undefined;
        this.role = obj.role !== undefined ? obj.role : DeviceRole.END_HOST;
        this.x = obj.x !== undefined ? _int(obj.x) : 0;
        this.y = obj.y !== undefined ? _int(obj.y) : 0;
        this.interfaces = obj.interfaces !== undefined ? { ...obj.interfaces } : {};
        this.gateway = obj.gateway !== undefined ? obj.gateway : "";
        // IPv6 dual-stack: interfaces_v6 keyed like interfaces; gateway_v6 for hosts.
        this.interfaces_v6 = obj.interfaces_v6 !== undefined ? { ...obj.interfaces_v6 } : {};
        this.gateway_v6 = obj.gateway_v6 !== undefined ? obj.gateway_v6 : "";
        // The host's access VLAN (0 = none / untagged). Hosts only.
        this.vlan = obj.vlan !== undefined ? _int(obj.vlan) : 0;
        // Laptop connected over WiFi (wireless NIC + auto-association to an AP).
        this.wireless = obj.wireless !== undefined ? obj.wireless : false;
        // The AP of this WiFi client's LAN. The deploy pins the client to it (every AP-PT
        // says "Default", so a laptop otherwise joins whichever AP it hears first).
        this.ap = obj.ap !== undefined ? obj.ap : "";
    }
    toDict() {
        return {
            name: this.name, model: this.model, category: this.category, role: this.role,
            x: this.x, y: this.y, interfaces: { ...this.interfaces }, gateway: this.gateway,
            interfaces_v6: { ...this.interfaces_v6 }, gateway_v6: this.gateway_v6,
            vlan: this.vlan, wireless: this.wireless, ap: this.ap,
        };
    }
}

export class LinkPlan {
    /** A link between two devices. */
    constructor(obj = {}) {
        this.device_a = obj.device_a !== undefined ? obj.device_a : undefined;
        this.port_a = obj.port_a !== undefined ? obj.port_a : undefined;
        this.device_b = obj.device_b !== undefined ? obj.device_b : undefined;
        this.port_b = obj.port_b !== undefined ? obj.port_b : undefined;
        this.cable = obj.cable !== undefined ? obj.cable : "straight";
    }
    toDict() {
        return {
            device_a: this.device_a, port_a: this.port_a, device_b: this.device_b,
            port_b: this.port_b, cable: this.cable,
        };
    }
}

export class ModulePlan {
    /** An expansion module to install on a device.
     *
     * `slot` is passed as is to PTBuilder's `addModule(device, slot, model)`.
     * The format depends on the device's slot type:
     *   - HWIC (1941/2901/2911): "0/0", "0/1", "0/2", "0/3"
     *   - NM (2911):             "1" or "2"
     *   - NIM (ISR4321/4331):    "0" or "1"
     *   - Cloud-PT/Server:       "0".."6" depending on the available slot
     */
    constructor(obj = {}) {
        this.device = obj.device !== undefined ? obj.device : undefined;
        this.slot = obj.slot !== undefined ? ModulePlan._coerce_slot_to_str(obj.slot) : undefined;
        this.module = obj.module !== undefined ? obj.module : undefined; // e.g. "HWIC-2T", "NIM-2T"
    }
    static _coerce_slot_to_str(v) {
        // We accept int (e.g. 0) for backward compatibility and convert it to "0".
        if (typeof v === "boolean") {
            throw new Error("slot must be str or int, not bool");
        }
        if (typeof v === "number" && Number.isInteger(v)) {
            return String(v);
        }
        return v;
    }
    toDict() { return { device: this.device, slot: this.slot, module: this.module }; }
}

export class DHCPPool {
    /** A DHCP pool on a router. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.pool_name = obj.pool_name !== undefined ? obj.pool_name : undefined;
        this.network = obj.network !== undefined ? obj.network : undefined;
        this.mask = obj.mask !== undefined ? obj.mask : undefined;
        this.gateway = obj.gateway !== undefined ? obj.gateway : undefined;
        this.dns = obj.dns !== undefined ? obj.dns : "8.8.8.8";
        this.excluded_start = obj.excluded_start !== undefined ? obj.excluded_start : "";
        this.excluded_end = obj.excluded_end !== undefined ? obj.excluded_end : "";
    }
    toDict() {
        return {
            router: this.router, pool_name: this.pool_name, network: this.network,
            mask: this.mask, gateway: this.gateway, dns: this.dns,
            excluded_start: this.excluded_start, excluded_end: this.excluded_end,
        };
    }
}

export class StaticRoute {
    /** A static route. admin_distance > 1 makes it a floating route. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.destination = obj.destination !== undefined ? obj.destination : undefined;
        this.mask = obj.mask !== undefined ? obj.mask : undefined;
        this.next_hop = obj.next_hop !== undefined ? obj.next_hop : undefined;
        this.admin_distance = obj.admin_distance !== undefined ? _int(obj.admin_distance) : 1;
    }
    toDict() {
        return {
            router: this.router, destination: this.destination, mask: this.mask,
            next_hop: this.next_hop, admin_distance: this.admin_distance,
        };
    }
}

export class OSPFConfig {
    /** OSPF configuration for a router. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.process_id = obj.process_id !== undefined ? _int(obj.process_id) : 1;
        this.router_id = obj.router_id !== undefined ? obj.router_id : "";
        this.networks = obj.networks !== undefined ? obj.networks.map((n) => (n && typeof n === "object" ? { ...n } : n)) : [];
    }
    toDict() {
        return {
            router: this.router, process_id: this.process_id, router_id: this.router_id,
            networks: this.networks.map((n) => (n && typeof n === "object" ? { ...n } : n)),
        };
    }
}

export class RIPConfig {
    /** RIP v2 configuration for a router. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.version = obj.version !== undefined ? _int(obj.version) : 2;
        this.networks = obj.networks !== undefined ? [...obj.networks] : [];
        this.no_auto_summary = obj.no_auto_summary !== undefined ? obj.no_auto_summary : true;
    }
    toDict() {
        return {
            router: this.router, version: this.version, networks: [...this.networks],
            no_auto_summary: this.no_auto_summary,
        };
    }
}

export class EIGRPConfig {
    /** EIGRP configuration for a router. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.as_number = obj.as_number !== undefined ? _int(obj.as_number) : 100;
        this.networks = obj.networks !== undefined ? obj.networks.map((n) => (n && typeof n === "object" ? { ...n } : n)) : []; // [{network, wildcard}]
        this.no_auto_summary = obj.no_auto_summary !== undefined ? obj.no_auto_summary : true;
    }
    toDict() {
        return {
            router: this.router, as_number: this.as_number,
            networks: this.networks.map((n) => (n && typeof n === "object" ? { ...n } : n)),
            no_auto_summary: this.no_auto_summary,
        };
    }
}

export class ValidationCheck {
    /** A check to run post-deploy. */
    constructor(obj = {}) {
        this.check_type = obj.check_type !== undefined ? obj.check_type : undefined;
        this.from_device = obj.from_device !== undefined ? obj.from_device : undefined;
        this.to_target = obj.to_target !== undefined ? obj.to_target : "";
        this.expected = obj.expected !== undefined ? obj.expected : "";
    }
    toDict() {
        return {
            check_type: this.check_type, from_device: this.from_device,
            to_target: this.to_target, expected: this.expected,
        };
    }
}

export class TopologyPlan {
    /** Complete, validated plan, ready to generate scripts. */
    constructor(obj = {}) {
        this.name = obj.name !== undefined ? obj.name : "topology";
        this.devices = obj.devices !== undefined ? _wrapList(DevicePlan, obj.devices) : [];
        this.modules = obj.modules !== undefined ? _wrapList(ModulePlan, obj.modules) : [];
        this.links = obj.links !== undefined ? _wrapList(LinkPlan, obj.links) : [];
        this.dhcp_pools = obj.dhcp_pools !== undefined ? _wrapList(DHCPPool, obj.dhcp_pools) : [];
        this.static_routes = obj.static_routes !== undefined ? _wrapList(StaticRoute, obj.static_routes) : [];
        this.ospf_configs = obj.ospf_configs !== undefined ? _wrapList(OSPFConfig, obj.ospf_configs) : [];
        this.rip_configs = obj.rip_configs !== undefined ? _wrapList(RIPConfig, obj.rip_configs) : [];
        this.eigrp_configs = obj.eigrp_configs !== undefined ? _wrapList(EIGRPConfig, obj.eigrp_configs) : [];
        // VLAN / trunk / inter-VLAN (router-on-a-stick)
        this.vlans = obj.vlans !== undefined ? _wrapList(VLANConfig, obj.vlans) : [];
        this.access_ports = obj.access_ports !== undefined ? _wrapList(AccessPortConfig, obj.access_ports) : [];
        this.trunks = obj.trunks !== undefined ? _wrapList(TrunkConfig, obj.trunks) : [];
        this.subinterfaces = obj.subinterfaces !== undefined ? _wrapList(SubinterfaceConfig, obj.subinterfaces) : [];
        this.validations = obj.validations !== undefined ? _wrapList(ValidationCheck, obj.validations) : [];
        // IPv6 dual-stack on (hosts use SLAAC, routers get ipv6 address via CLI)
        this.dual_stack = obj.dual_stack !== undefined ? obj.dual_stack : false;
        // IOS lines per device, typed from global config after the generated config
        // (summaries, hardening, ACLs, NAT...): one deploy carries a whole custom design.
        this.extra_cli = obj.extra_cli !== undefined ? _copyDictOfLists(obj.extra_cli) : {};
        this.errors = obj.errors !== undefined ? [...obj.errors] : [];
        this.warnings = obj.warnings !== undefined ? [...obj.warnings] : [];
    }

    get is_valid() {
        return this.errors.length === 0;
    }

    device_by_name(name) {
        for (const d of this.devices) {
            if (d.name === name) {
                return d;
            }
        }
        return null;
    }

    devices_by_category(category) {
        return this.devices.filter((d) => d.category === category);
    }

    toDict() {
        return {
            name: this.name, devices: _dictList(this.devices), modules: _dictList(this.modules),
            links: _dictList(this.links), dhcp_pools: _dictList(this.dhcp_pools),
            static_routes: _dictList(this.static_routes), ospf_configs: _dictList(this.ospf_configs),
            rip_configs: _dictList(this.rip_configs), eigrp_configs: _dictList(this.eigrp_configs),
            vlans: _dictList(this.vlans), access_ports: _dictList(this.access_ports),
            trunks: _dictList(this.trunks), subinterfaces: _dictList(this.subinterfaces),
            validations: _dictList(this.validations), dual_stack: this.dual_stack,
            extra_cli: _copyDictOfLists(this.extra_cli), errors: [...this.errors],
            warnings: [...this.warnings],
        };
    }
}
