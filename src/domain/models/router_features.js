// Router feature models sent as IOS CLI: HSRP, BGP and QoS (MQC).

function _wrap(cls, v) {
    if (v === null || v === undefined) return v;
    return v instanceof cls ? v : new cls(v);
}
function _wrapList(cls, v) { return (v || []).map((x) => _wrap(cls, x)); }
function _dictList(v) { return (v || []).map((x) => (x && typeof x.toDict === "function" ? x.toDict() : x)); }
function _int(v) { return typeof v === "string" ? parseInt(v, 10) : v; }
function _intOrNull(v) {
    if (v === null || v === undefined) return null;
    return _int(v);
}

export class HsrpConfig {
    /** One HSRP group on a router interface. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.interface = obj.interface !== undefined ? obj.interface : undefined;
        this.group = obj.group !== undefined ? _int(obj.group) : undefined;
        this.virtual_ip = obj.virtual_ip !== undefined ? obj.virtual_ip : undefined;
        this.priority = obj.priority !== undefined ? _int(obj.priority) : 100;
        this.preempt = obj.preempt !== undefined ? obj.preempt : true;
        this.version = obj.version !== undefined ? _int(obj.version) : 2;
    }
    toDict() {
        return {
            router: this.router, interface: this.interface, group: this.group,
            virtual_ip: this.virtual_ip, priority: this.priority, preempt: this.preempt,
            version: this.version,
        };
    }
}

export class BgpNeighbor {
    constructor(obj = {}) {
        this.ip = obj.ip !== undefined ? obj.ip : undefined;
        this.remote_as = obj.remote_as !== undefined ? _int(obj.remote_as) : undefined;
    }
    toDict() { return { ip: this.ip, remote_as: this.remote_as }; }
}

export class BgpConfig {
    /** `router bgp <asn>` with its neighbors and advertised networks (CIDR). */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.asn = obj.asn !== undefined ? _int(obj.asn) : undefined;
        this.neighbors = obj.neighbors !== undefined ? _wrapList(BgpNeighbor, obj.neighbors) : [];
        this.networks = obj.networks !== undefined ? [...obj.networks] : [];
    }
    toDict() {
        return {
            router: this.router, asn: this.asn, neighbors: _dictList(this.neighbors),
            networks: [...this.networks],
        };
    }
}

export class QosClass {
    /** A class-map (match-any) and its action inside the policy-map. */
    constructor(obj = {}) {
        this.name = obj.name !== undefined ? obj.name : undefined;
        this.match_dscp = obj.match_dscp !== undefined ? obj.match_dscp : null;
        this.match_protocol = obj.match_protocol !== undefined ? obj.match_protocol : null;
        this.priority_kbps = obj.priority_kbps !== undefined ? _intOrNull(obj.priority_kbps) : null; // LLQ (strict priority queue)
        this.bandwidth_kbps = obj.bandwidth_kbps !== undefined ? _intOrNull(obj.bandwidth_kbps) : null; // CBWFQ guarantee
    }
    toDict() {
        return {
            name: this.name, match_dscp: this.match_dscp, match_protocol: this.match_protocol,
            priority_kbps: this.priority_kbps, bandwidth_kbps: this.bandwidth_kbps,
        };
    }
}

export class QosConfig {
    /** A policy-map attached to a router interface; class-default gets fair-queue. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.interface = obj.interface !== undefined ? obj.interface : undefined;
        this.policy_name = obj.policy_name !== undefined ? obj.policy_name : undefined;
        this.classes = obj.classes !== undefined ? _wrapList(QosClass, obj.classes) : [];
        this.direction = obj.direction !== undefined ? obj.direction : "output";
    }
    toDict() {
        return {
            router: this.router, interface: this.interface, policy_name: this.policy_name,
            classes: _dictList(this.classes), direction: this.direction,
        };
    }
}
