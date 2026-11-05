// NetFlow exporter on a PT device.
//
// Unlike the rest of the advanced features, NetFlow is NOT applied via CLI:
// PT's native API exposes `NFExporterManager.createNFExporter(name)` and the
// exporter's setters, so it is configured as an object and can be read back to
// verify it (`isFullyConfigured()`).

export class NetflowExporter {
    /** A NetFlow exporter: where the device sends its flows. */
    constructor(obj = {}) {
        this.device = obj.device !== undefined ? obj.device : undefined;
        this.name = obj.name !== undefined ? obj.name : undefined;
        this.destination_ip = obj.destination_ip !== undefined ? obj.destination_ip : "";
        this.udp_port = obj.udp_port !== undefined ? (typeof obj.udp_port === "string" ? parseInt(obj.udp_port, 10) : obj.udp_port) : 2055;
        this.version = obj.version !== undefined ? (typeof obj.version === "string" ? parseInt(obj.version, 10) : obj.version) : 9;
        this.source_port = obj.source_port !== undefined ? obj.source_port : ""; // source interface; empty = PT picks it
        this.monitors = obj.monitors !== undefined ? [...obj.monitors] : [];
    }
    toDict() {
        return {
            device: this.device, name: this.name, destination_ip: this.destination_ip,
            udp_port: this.udp_port, version: this.version, source_port: this.source_port,
            monitors: [...this.monitors],
        };
    }
}
