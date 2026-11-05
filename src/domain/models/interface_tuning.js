// Per-interface fine-tuning model (clock-rate, bandwidth, OSPF/EIGRP knobs).

function _intOrNull(v) {
    if (v === null || v === undefined) return null;
    return typeof v === "string" ? parseInt(v, 10) : v;
}

export class InterfaceTuning {
    /** Parameters of a specific router interface. All optional. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.interface = obj.interface !== undefined ? obj.interface : undefined;
        this.clock_rate = obj.clock_rate !== undefined ? _intOrNull(obj.clock_rate) : null; // Serial interfaces only (DCE end)
        this.bandwidth = obj.bandwidth !== undefined ? _intOrNull(obj.bandwidth) : null; // kbps
        this.ospf_cost = obj.ospf_cost !== undefined ? _intOrNull(obj.ospf_cost) : null;
        this.ospf_priority = obj.ospf_priority !== undefined ? _intOrNull(obj.ospf_priority) : null;
        this.ospf_hello_interval = obj.ospf_hello_interval !== undefined ? _intOrNull(obj.ospf_hello_interval) : null;
        this.ospf_dead_interval = obj.ospf_dead_interval !== undefined ? _intOrNull(obj.ospf_dead_interval) : null;
        this.delay = obj.delay !== undefined ? _intOrNull(obj.delay) : null; // EIGRP delay (tens of microseconds)
        // OSPF network type. PT 9.0.1 only accepts point-to-point (`broadcast` is rejected).
        this.ospf_network = obj.ospf_network !== undefined ? obj.ospf_network : null;
        // OSPF authentication. With `ospf_md5_key` message-digest is used (recommended);
        // `ospf_auth_key` alone is plain-text authentication, which travels readable.
        this.ospf_auth_key = obj.ospf_auth_key !== undefined ? obj.ospf_auth_key : null;
        this.ospf_md5_key_id = obj.ospf_md5_key_id !== undefined ? _intOrNull(obj.ospf_md5_key_id) : null;
        this.ospf_md5_key = obj.ospf_md5_key !== undefined ? obj.ospf_md5_key : null;
    }

    uses_md5_auth() {
        return this.ospf_md5_key !== null && this.ospf_md5_key !== undefined;
    }

    changes_ospf() {
        /** True when the change resets this interface's OSPF adjacency. */
        return [
            this.ospf_cost, this.ospf_priority, this.ospf_hello_interval, this.ospf_dead_interval,
            this.ospf_network, this.ospf_auth_key, this.ospf_md5_key,
        ].some((v) => v !== null && v !== undefined);
    }

    is_serial() {
        return this.interface.toLowerCase().startsWith("serial");
    }

    toDict() {
        return {
            router: this.router, interface: this.interface, clock_rate: this.clock_rate,
            bandwidth: this.bandwidth, ospf_cost: this.ospf_cost, ospf_priority: this.ospf_priority,
            ospf_hello_interval: this.ospf_hello_interval, ospf_dead_interval: this.ospf_dead_interval,
            delay: this.delay, ospf_network: this.ospf_network, ospf_auth_key: this.ospf_auth_key,
            ospf_md5_key_id: this.ospf_md5_key_id, ospf_md5_key: this.ospf_md5_key,
        };
    }
}
