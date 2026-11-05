// Convergence reads: routes, OSPF, ARP, CDP, STP, ACL, NAT, MAC tables and DHCP leases.

import {
    acl_report, arp_report, cdp_report, dhcp_leases_report, mac_table_report, nat_report,
    ospf_report,
    routes_report, select_devices, stp_report,
} from "../../../domain/services/convergence.js";
import {
    acl_js, arp_js, cdp_js, dhcp_leases_js, mac_table_js, nat_js, ospf_js, routes_js, stp_js,
} from "../../../infrastructure/generator/state_js.js";
import { TIMEOUT_MSG } from "../bridge_context.js";
import { reply_json } from "../../../shared/utils.js";


export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _TIMEOUT_MSG = TIMEOUT_MSG;
    const _bridge_send_and_wait = async (js, timeout) => await ctx.send_and_wait(js, timeout);
    const _check_bridge = async () => await ctx.check_bridge();

    async function _read(js, device, what, report) {
        /** Send one reader, then select the devices that answered and normalize them. */
        const err = await _check_bridge();
        if (err) {
            return err;
        }
        // A sweep of every device takes longer than a single read.
        const raw = await _bridge_send_and_wait(js, device.trim() ? 15.0 : 30.0);
        if (raw === null || raw === undefined) {
            return _TIMEOUT_MSG;
        }
        if (raw.startsWith("ERROR:")) {
            return `PT error: ${raw}`;
        }
        let data;
        try {
            data = JSON.parse(raw);
        } catch (exc) {
            return `Unreadable reply from PT: ${exc.message !== undefined ? exc.message : exc}`;
        }
        const devices = select_devices(data, device.trim(), what);
        if (typeof devices === "string") {
            return devices;
        }
        return reply_json(report(devices));
    }

    registry.tool("pt_read_routes", async (args) => {
        const device = args.device !== undefined ? args.device : "";
        return _read(routes_js(device.trim()), device, "a routing table", routes_report);
    });

    registry.tool("pt_read_ospf", async (args) => {
        const device = args.device !== undefined ? args.device : "";
        return _read(ospf_js(device.trim()), device, "OSPF", ospf_report);
    });

    registry.tool("pt_read_arp", async (args) => {
        const device = args.device !== undefined ? args.device : "";
        return _read(arp_js(device.trim()), device, "an ARP table", arp_report);
    });

    registry.tool("pt_read_cdp", async (args) => {
        const device = args.device !== undefined ? args.device : "";
        return _read(cdp_js(device.trim()), device, "CDP", cdp_report);
    });

    registry.tool("pt_read_stp", async (args) => {
        const switch_ = args.switch !== undefined ? args.switch : "";
        const vlans = args.vlans !== undefined ? args.vlans : null;
        return _read(stp_js(switch_.trim(), vlans), switch_, "STP", stp_report);
    });

    registry.tool("pt_read_acl", async (args) => {
        const device = args.device !== undefined ? args.device : "";
        return _read(acl_js(device.trim()), device, "ACLs", acl_report);
    });

    registry.tool("pt_read_nat", async (args) => {
        const device = args.device !== undefined ? args.device : "";
        return _read(nat_js(device.trim()), device, "NAT", nat_report);
    });

    registry.tool("pt_read_mac_table", async (args) => {
        const switch_ = args.switch !== undefined ? args.switch : "";
        const vlan = args.vlan !== undefined ? args.vlan : 0;
        return _read(mac_table_js(switch_.trim(), vlan), switch_, "a MAC table",
                     mac_table_report);
    });

    registry.tool("pt_read_dhcp_leases", async (args) => {
        const device = args.device !== undefined ? args.device : "";
        return _read(dhcp_leases_js(device.trim()), device, "a DHCP server",
                     dhcp_leases_report);
    });
}
