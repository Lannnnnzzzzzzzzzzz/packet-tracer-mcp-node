// DHCP pool on a Server-PT (Services > DHCP in the GUI).
//
// It is not the same DHCP as a router's: there the pool is created with IOS CLI
// (`ip dhcp pool`), while a Server-PT has no CLI. PT's native API exposes it, one
// level lower than it looks:
//
//     getProcess("DhcpServerMain")                 -> DhcpServerMainProcess
//       .getDhcpServerProcessByPortName("FastEthernet0") -> DhcpServerProcess
//         .addPool(name) / .getPool(name) / .setEnable(bool)
//           -> DhcpPool: setNetworkAddress, setNetworkMask(network, mask), ...
//
// `DhcpServerMain` itself has no pool methods at all; that is why it looked like
// PT didn't allow configuring it (issue #23).

// The pool every Server-PT ships with; it is the one the GUI shows.
export const DEFAULT_SERVER_POOL = "serverPool";

export class DhcpServerPool {
    /** A DHCP pool served by a Server-PT from one of its ports. */
    constructor(obj = {}) {
        this.device = obj.device !== undefined ? obj.device : undefined;
        this.pool_name = obj.pool_name !== undefined ? obj.pool_name : DEFAULT_SERVER_POOL;
        this.port = obj.port !== undefined ? obj.port : "FastEthernet0";
        this.network = obj.network !== undefined ? obj.network : "";
        this.mask = obj.mask !== undefined ? obj.mask : "255.255.255.0";
        this.gateway = obj.gateway !== undefined ? obj.gateway : "";
        this.dns = obj.dns !== undefined ? obj.dns : "";
        this.start_ip = obj.start_ip !== undefined ? obj.start_ip : ""; // empty = first free host after the gateway
        this.max_users = obj.max_users !== undefined ? (typeof obj.max_users === "string" ? parseInt(obj.max_users, 10) : obj.max_users) : 0; // 0 = up to the end of the subnet
    }
    toDict() {
        return {
            device: this.device, pool_name: this.pool_name, port: this.port,
            network: this.network, mask: this.mask, gateway: this.gateway,
            dns: this.dns, start_ip: this.start_ip, max_users: this.max_users,
        };
    }
}
