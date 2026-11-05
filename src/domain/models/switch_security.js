// Switch security models: STP and port-security.

function _int(v) { return typeof v === "string" ? parseInt(v, 10) : v; }

export class PortSecurityConfig {
    /** Port-security on a switch access port. */
    constructor(obj = {}) {
        this.switch = obj.switch !== undefined ? obj.switch : undefined;
        this.port = obj.port !== undefined ? obj.port : undefined;
        this.max_mac = obj.max_mac !== undefined ? _int(obj.max_mac) : 1;
        this.violation = obj.violation !== undefined ? obj.violation : "shutdown";
        this.sticky = obj.sticky !== undefined ? obj.sticky : true;
        this.static_macs = obj.static_macs !== undefined ? [...obj.static_macs] : [];
    }
    toDict() {
        return {
            switch: this.switch, port: this.port, max_mac: this.max_mac,
            violation: this.violation, sticky: this.sticky, static_macs: [...this.static_macs],
        };
    }
}

export class STPConfig {
    /** Spanning-tree on a switch. */
    constructor(obj = {}) {
        this.switch = obj.switch !== undefined ? obj.switch : undefined;
        this.mode = obj.mode !== undefined ? obj.mode : "rapid-pvst";
        this.root_primary_vlans = obj.root_primary_vlans !== undefined ? [...obj.root_primary_vlans] : [];
        this.priority = obj.priority !== undefined ? { ...obj.priority } : {}; // vlan -> priority
        this.portfast_ports = obj.portfast_ports !== undefined ? [...obj.portfast_ports] : [];
        this.bpduguard_ports = obj.bpduguard_ports !== undefined ? [...obj.bpduguard_ports] : [];
    }
    toDict() {
        return {
            switch: this.switch, mode: this.mode, root_primary_vlans: [...this.root_primary_vlans],
            priority: { ...this.priority }, portfast_ports: [...this.portfast_ports],
            bpduguard_ports: [...this.bpduguard_ports],
        };
    }
}
