// CLI generator for Cisco CME voice on a router and the voice VLAN on a switch.
//
// Measured on a 2811 in PT 9 (status 0 from enterCommand): `telephony-service`,
// `max-ephones`, `max-dn`, `ip source-address <ip> port 2000`, `auto assign 1 to <n>`,
// `ephone-dn <n>` and `number <ext>`. NOT measured yet: `ephone` / `mac-address` /
// `button`, `option 150 ip` in a DHCP pool and `switchport voice vlan` on a 2960.

import { pyTruthy } from "../../shared/pycompat.js";
import { IPv4Address, ip_network } from "../../shared/ipnet.js";
import { normalize_mac } from "../../domain/models/voice.js";
import { WALK_JS } from "./walk_js.js";

function _ip(text) {
    try {
        return String(new IPv4Address(text.trim()));
    } catch (e) {
        return text.trim();
    }
}

export function generate_voice_router_cli(cfg) {
    // telephony-service, one ephone-dn per extension, static ephones and DHCP option 150.
    const src = _ip(cfg.source_ip);
    const lines = [
        "telephony-service",
        ` max-ephones ${cfg.max_ephones}`,
        ` max-dn ${cfg.max_dn}`,
        ` ip source-address ${src} port ${cfg.source_port}`,
    ];
    if (cfg.auto_assign && pyTruthy(cfg.extensions)) {
        lines.push(` auto assign 1 to ${cfg.extensions.length}`);
    }
    lines.push(" exit");
    cfg.extensions.forEach((ext, idx) => {
        const dn = idx + 1;
        lines.push(`ephone-dn ${dn}`, ` number ${ext.number.trim()}`, " exit");
    });
    let ephone = 0;
    cfg.extensions.forEach((ext, idx) => {
        const dn = idx + 1;
        if (!pyTruthy(ext.mac)) {
            return;
        }
        ephone += 1;
        lines.push(`ephone ${ephone}`,
                  ` mac-address ${normalize_mac(ext.mac) || ext.mac.trim()}`,
                  ` button 1:${dn}`,
                  " exit");
    });
    if (pyTruthy(cfg.dhcp_pool)) {
        const pool = cfg.dhcp_pool.trim();
        let net = null;
        if (pyTruthy(cfg.dhcp_network)) {
            try {
                net = ip_network(cfg.dhcp_network.trim(), false);
            } catch (e) {
                net = null;
            }
        }
        if (net !== null && net !== undefined) {
            lines.push(`ip dhcp excluded-address ${src}`);
        }
        lines.push(`ip dhcp pool ${pool}`);
        if (net !== null && net !== undefined) {
            lines.push(` network ${net.network_address} ${net.netmask}`,
                      ` default-router ${src}`);
        }
        lines.push(` option 150 ip ${src}`, " exit");
    }
    return lines;
}

export function generate_voice_switch_cli(cfg) {
    // The voice VLAN and `switchport voice vlan` on each access port (phone + PC).
    if (cfg.voice_vlan === null || cfg.voice_vlan === undefined || !pyTruthy(cfg.switch)) {
        return [];
    }
    const lines = [];
    if (cfg.voice_vlan !== 1) {
        lines.push(`vlan ${cfg.voice_vlan}`, " exit");
    }
    for (const port of cfg.access_ports) {
        lines.push(`interface ${port.trim()}`,
                  " switchport mode access",
                  ` switchport voice vlan ${cfg.voice_vlan}`,
                  " exit");
    }
    return lines;
}

export function restart_ip_phones_js() {
    // Power-cycles every IP phone on the canvas, then fast-forwards PT's clock.
    //
    // Measured live on PT 9.0.1: phones that were already on when CME and its DHCP
    // pool were configured stay at 0.0.0.0 (their DHCP request was lost and is never
    // retried); a power-cycle plus fastForwardTime gets them a lease, and they
    // register (`show ephone`: REGISTERED). IP phones report getType() 12.
    return (
        "(function(){try{" + WALK_JS +
        "var n=[];__eachDevice(function(d){if(d.getType()===12){"
        + "d.setPower(false);d.setPower(true);n.push(String(d.getName()));}});"
        + "var ff=false;try{ipc.appWindow().getRealtimeToolbar().fastForwardTime();ff=true;}catch(e){}"
        + "reportResult(JSON.stringify({restarted:n,fast_forwarded:ff}));"
        + "}catch(e){reportResult(JSON.stringify({error:String(e)}));}})();"
    );
}
