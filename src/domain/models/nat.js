// NAT/PAT models — configuration and modes.
//
// NAT is applied post-deploy to an existing router via configureIosDevice
// through the bridge, just like ACLs.
//
// Three modes:
//   static  — fixed 1:1. Each private IP is mapped to a permanent public IP.
//              Use it when: an internal server must be reachable from the internet
//              always with the same public IP (e.g. a web, FTP or mail server).
//
//   dynamic — Pool of public IPs assigned on demand. The router picks which
//              public IP to give each internal host based on availability.
//              Use it when: you have more public IPs than overload justifies but
//              fewer than internal hosts; or when per-public-IP tracking matters.
//              Rare in today's networks.
//
//   pat     — PAT (Port Address Translation) / NAT Overload. Many internal hosts
//              share ONE single public IP using port numbers to tell
//              them apart. It is what almost every home and business router
//              does when it has a single IP from the ISP.
//              Use it when: you have 1 (or a few) public IPs and N internal hosts.
//              Sub-modes:
//                use_interface_overload=True  → ip nat inside source list X interface <outside> overload
//                use_interface_overload=False → ip nat inside source list X pool POOL overload

function _wrap(cls, v) {
    if (v === null || v === undefined) return v;
    return v instanceof cls ? v : new cls(v);
}
function _wrapList(cls, v) { return (v || []).map((x) => _wrap(cls, x)); }
function _dict(v) { return v && typeof v.toDict === "function" ? v.toDict() : v; }
function _dictList(v) { return (v || []).map(_dict); }

export class NATStaticMapping {
    /** inside-local ↔ inside-global pair for static NAT. */
    constructor(obj = {}) {
        this.inside_local = obj.inside_local !== undefined ? obj.inside_local : undefined; // private IP, e.g. "192.168.1.10"
        this.inside_global = obj.inside_global !== undefined ? obj.inside_global : undefined; // fixed public IP, e.g. "200.1.1.5"
    }
    toDict() { return { inside_local: this.inside_local, inside_global: this.inside_global }; }
}

export class NATPool {
    /** Pool of public IPs for dynamic NAT or PAT with a pool. */
    constructor(obj = {}) {
        this.name = obj.name !== undefined ? obj.name : "NAT-POOL";
        this.start_ip = obj.start_ip !== undefined ? obj.start_ip : undefined; // first IP of the pool, e.g. "200.1.1.1"
        this.end_ip = obj.end_ip !== undefined ? obj.end_ip : undefined; // last IP of the pool,  e.g. "200.1.1.10"
        this.netmask = obj.netmask !== undefined ? obj.netmask : undefined; // network mask, e.g. "255.255.255.0"
    }
    toDict() {
        return { name: this.name, start_ip: this.start_ip, end_ip: this.end_ip, netmask: this.netmask };
    }
}

export class NATConfig {
    /** Full NAT/PAT configuration for a router. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.mode = obj.mode !== undefined ? obj.mode : undefined;
        // Interface connected to the private network (LAN)
        this.inside_interface = obj.inside_interface !== undefined ? obj.inside_interface : undefined; // ej: "GigabitEthernet0/0"
        // Interface connected to the public network (WAN/Internet)
        this.outside_interface = obj.outside_interface !== undefined ? obj.outside_interface : undefined; // ej: "GigabitEthernet0/1"
        // --- static mode ---
        // List of inside-local ↔ inside-global pairs.
        // Required when mode="static".
        this.static_mappings = obj.static_mappings !== undefined ? _wrapList(NATStaticMapping, obj.static_mappings) : [];
        // --- dynamic / pat modes ---
        // ACL number or name identifying the internal hosts to translate.
        this.acl_number = obj.acl_number !== undefined ? obj.acl_number : "1";
        // Internal networks in "network wildcard" format, e.g. "192.168.1.0 0.0.0.255".
        // Used to generate the inline access-list. If the ACL already exists in PT
        // you can leave this list empty and the generator skips the access-list.
        this.inside_networks = obj.inside_networks !== undefined ? [...obj.inside_networks] : [];
        // Pool of public IPs. Required for dynamic; optional in pat when
        // use_interface_overload=True.
        this.pool = obj.pool !== undefined && obj.pool !== null ? _wrap(NATPool, obj.pool) : (obj.pool !== undefined ? null : null);
        // PAT only: if True it generates "ip nat inside source list X interface <outside> overload"
        // instead of using a pool. Typical when the ISP assigns a single IP to the WAN interface.
        this.use_interface_overload = obj.use_interface_overload !== undefined ? obj.use_interface_overload : false;
    }
    toDict() {
        return {
            router: this.router, mode: this.mode, inside_interface: this.inside_interface,
            outside_interface: this.outside_interface, static_mappings: _dictList(this.static_mappings),
            acl_number: this.acl_number, inside_networks: [...this.inside_networks],
            pool: this.pool !== null && this.pool !== undefined ? _dict(this.pool) : null,
            use_interface_overload: this.use_interface_overload,
        };
    }
}
