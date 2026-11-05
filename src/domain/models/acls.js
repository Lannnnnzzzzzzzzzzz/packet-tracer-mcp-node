// ACL models — rules, plans and bindings.
//
// ACLs are applied post-deploy to an existing router via configureIosDevice
// through the bridge. They are not part of the main TopologyPlan because they
// are discrete changes to an already deployed topology.

function _wrap(cls, v) {
    if (v === null || v === undefined) return v;
    return v instanceof cls ? v : new cls(v);
}
function _wrapList(cls, v) {
    return (v || []).map((x) => _wrap(cls, x));
}
function _dict(v) { return v && typeof v.toDict === "function" ? v.toDict() : v; }
function _dictList(v) { return (v || []).map(_dict); }

export class ACLEntry {
    /** A single ACL rule.
     *
     * In IOS, standard ACLs only filter by source. Extended ones
     * allow source + destination + protocol + ports + flags.
     */
    constructor(obj = {}) {
        this.sequence = obj.sequence !== undefined ? obj.sequence : null;
        this.action = obj.action !== undefined ? obj.action : undefined;
        this.protocol = obj.protocol !== undefined ? obj.protocol : "ip";
        this.source = obj.source !== undefined ? obj.source : undefined;
        this.destination = obj.destination !== undefined ? obj.destination : "";
        this.source_port_op = obj.source_port_op !== undefined ? obj.source_port_op : null;
        this.source_port = obj.source_port !== undefined ? obj.source_port : null;
        this.source_port_end = obj.source_port_end !== undefined ? obj.source_port_end : null;
        this.dest_port_op = obj.dest_port_op !== undefined ? obj.dest_port_op : null;
        this.dest_port = obj.dest_port !== undefined ? obj.dest_port : null;
        this.dest_port_end = obj.dest_port_end !== undefined ? obj.dest_port_end : null;
        this.icmp_type = obj.icmp_type !== undefined ? obj.icmp_type : "";
        this.tcp_flags = obj.tcp_flags !== undefined ? [...obj.tcp_flags] : [];
        this.log = obj.log !== undefined ? obj.log : false;
        this.remark = obj.remark !== undefined ? obj.remark : "";
    }
    toDict() {
        return {
            sequence: this.sequence, action: this.action, protocol: this.protocol,
            source: this.source, destination: this.destination,
            source_port_op: this.source_port_op, source_port: this.source_port,
            source_port_end: this.source_port_end, dest_port_op: this.dest_port_op,
            dest_port: this.dest_port, dest_port_end: this.dest_port_end,
            icmp_type: this.icmp_type, tcp_flags: [...this.tcp_flags],
            log: this.log, remark: this.remark,
        };
    }
}

export class ACLPlan {
    /** Complete plan of an ACL for a specific router. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.name_or_number = obj.name_or_number !== undefined ? obj.name_or_number : undefined;
        this.acl_type = obj.acl_type !== undefined ? obj.acl_type : undefined;
        this.entries = obj.entries !== undefined ? _wrapList(ACLEntry, obj.entries) : [];
    }
    toDict() {
        return {
            router: this.router, name_or_number: this.name_or_number,
            acl_type: this.acl_type, entries: _dictList(this.entries),
        };
    }
}

export class ACLBinding {
    /** Applying an ACL to a router interface. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.interface = obj.interface !== undefined ? obj.interface : undefined;
        this.acl_id = obj.acl_id !== undefined ? obj.acl_id : undefined;
        this.direction = obj.direction !== undefined ? obj.direction : undefined;
    }
    toDict() {
        return {
            router: this.router, interface: this.interface,
            acl_id: this.acl_id, direction: this.direction,
        };
    }
}
