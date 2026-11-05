// VLAN / trunk / inter-VLAN routing (router-on-a-stick) models.

function _wrap(cls, v) {
    if (v === null || v === undefined) return v;
    return v instanceof cls ? v : new cls(v);
}
function _wrapList(cls, v) { return (v || []).map((x) => _wrap(cls, x)); }
function _dictList(v) { return (v || []).map((x) => (x && typeof x.toDict === "function" ? x.toDict() : x)); }
function _int(v) { return typeof v === "string" ? parseInt(v, 10) : v; }

export class VLANConfig {
    /** A VLAN. `subnet` is filled in by the IP planner (e.g. "192.168.10.0/24"). */
    constructor(obj = {}) {
        this.vlan_id = obj.vlan_id !== undefined ? _int(obj.vlan_id) : undefined;
        this.name = obj.name !== undefined ? obj.name : "";
        this.subnet = obj.subnet !== undefined ? obj.subnet : "";
    }
    toDict() { return { vlan_id: this.vlan_id, name: this.name, subnet: this.subnet }; }
}

export class AccessPortConfig {
    /** A switch port in access mode assigned to a VLAN. */
    constructor(obj = {}) {
        this.switch = obj.switch !== undefined ? obj.switch : undefined;
        this.port = obj.port !== undefined ? obj.port : undefined;
        this.vlan_id = obj.vlan_id !== undefined ? _int(obj.vlan_id) : undefined;
    }
    toDict() { return { switch: this.switch, port: this.port, vlan_id: this.vlan_id }; }
}

export class TrunkConfig {
    /** A switch port in trunk mode.
     *
     * Empty `allowed_vlans` = all. `encapsulation` is only emitted on
     * multi-encap switches (3560); the 2960 is dot1q-only and rejects the command.
     */
    constructor(obj = {}) {
        this.switch = obj.switch !== undefined ? obj.switch : undefined;
        this.port = obj.port !== undefined ? obj.port : undefined;
        this.allowed_vlans = obj.allowed_vlans !== undefined ? [...obj.allowed_vlans] : [];
        this.native_vlan = obj.native_vlan !== undefined ? _int(obj.native_vlan) : 1;
        this.encapsulation = obj.encapsulation !== undefined ? obj.encapsulation : "dot1q";
    }
    toDict() {
        return {
            switch: this.switch, port: this.port, allowed_vlans: [...this.allowed_vlans],
            native_vlan: this.native_vlan, encapsulation: this.encapsulation,
        };
    }
}

export class SubinterfaceConfig {
    /** A .1q subinterface on a router (inter-VLAN routing). */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.parent_port = obj.parent_port !== undefined ? obj.parent_port : undefined;
        this.vlan_id = obj.vlan_id !== undefined ? _int(obj.vlan_id) : undefined;
        this.ip_cidr = obj.ip_cidr !== undefined ? obj.ip_cidr : ""; // "192.168.10.1/24"
        this.encapsulation = obj.encapsulation !== undefined ? obj.encapsulation : "dot1Q";
    }
    toDict() {
        return {
            router: this.router, parent_port: this.parent_port, vlan_id: this.vlan_id,
            ip_cidr: this.ip_cidr, encapsulation: this.encapsulation,
        };
    }
}

export class VLANPlan {
    /** Aggregate for the post-deploy tool `pt_apply_vlan`. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : "";
        this.switch = obj.switch !== undefined ? obj.switch : "";
        this.vlans = obj.vlans !== undefined ? _wrapList(VLANConfig, obj.vlans) : [];
        this.access_ports = obj.access_ports !== undefined ? _wrapList(AccessPortConfig, obj.access_ports) : [];
        this.trunks = obj.trunks !== undefined ? _wrapList(TrunkConfig, obj.trunks) : [];
        this.subinterfaces = obj.subinterfaces !== undefined ? _wrapList(SubinterfaceConfig, obj.subinterfaces) : [];
    }
    toDict() {
        return {
            router: this.router, switch: this.switch, vlans: _dictList(this.vlans),
            access_ports: _dictList(this.access_ports), trunks: _dictList(this.trunks),
            subinterfaces: _dictList(this.subinterfaces),
        };
    }
}
