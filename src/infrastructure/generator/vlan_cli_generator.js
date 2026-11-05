// CLI generator for VLAN / trunk / inter-VLAN routing (router-on-a-stick).
//
// - Switch: defines VLANs, access ports and trunks.
// - Router: .1q subinterfaces (encapsulation dot1Q + ip address).
//
// `build_*_configure_payload` wraps with enable/configure terminal/end/write memory.
// `build_*_js_call` produces the call `configureIosDevice("dev","...\n...")` on a single
// JS line (the `\n` travel as literal escapes, not as code line breaks that executeCode strips).

import { pyJsonDumps, pyTruthy } from "../../shared/pycompat.js";
import { prefix_to_mask } from "../../shared/utils.js";

// Switch models that support multiple encapsulations and therefore REQUIRE
// `switchport trunk encapsulation dot1q` before `switchport mode trunk`.
// The 2960 is dot1q-only and REJECTS that command.
const _MULTI_ENCAP_SWITCHES = ["3560", "3650"];

export function switch_supports_encap(switch_model) {
    const model = (switch_model || "").toLowerCase();
    return _MULTI_ENCAP_SWITCHES.some((m) => model.includes(m));
}

export function generate_switch_vlan_cli(
    vlans,
    access_ports,
    trunks,
    supports_encap = false,
) {
    // IOS lines to configure VLANs + access ports + trunks on ONE switch.
    const lines = [];

    // Define the VLANs in the database
    for (const v of vlans) {
        lines.push(`vlan ${v.vlan_id}`);
        if (pyTruthy(v.name)) {
            lines.push(` name ${v.name}`);
        }
        lines.push(" exit");
    }

    // Access ports
    for (const ap of access_ports) {
        lines.push(`interface ${ap.port}`);
        lines.push(" switchport mode access");
        lines.push(` switchport access vlan ${ap.vlan_id}`);
        lines.push(" exit");
    }

    // Trunks
    for (const t of trunks) {
        lines.push(`interface ${t.port}`);
        if (supports_encap) {
            lines.push(` switchport trunk encapsulation ${t.encapsulation}`);
        }
        lines.push(" switchport mode trunk");
        if (pyTruthy(t.native_vlan) && t.native_vlan !== 1) {
            lines.push(` switchport trunk native vlan ${t.native_vlan}`);
        }
        if (pyTruthy(t.allowed_vlans)) {
            const allowed = t.allowed_vlans.map(String).join(",");
            lines.push(` switchport trunk allowed vlan ${allowed}`);
        }
        lines.push(" exit");
    }

    return lines;
}

export function generate_router_subinterface_cli(
    subinterfaces,
    interfaces_v6 = null,
) {
    // IOS lines for .1q subinterfaces of inter-VLAN routing on ONE router.
    //
    // `interfaces_v6` (the router's, keyed "Gig0/0.10") adds the dual-stack address.
    const lines = [];
    // The physical parent port must be 'no shutdown' for the subinterfaces to come up.
    const parents = [];
    for (const s of subinterfaces) {
        if (!parents.includes(s.parent_port)) {
            parents.push(s.parent_port);
        }
    }
    for (const p of parents) {
        lines.push(`interface ${p}`);
        lines.push(" no shutdown");
        lines.push(" exit");
    }
    for (const s of subinterfaces) {
        lines.push(`interface ${s.parent_port}.${s.vlan_id}`);
        lines.push(` encapsulation ${s.encapsulation} ${s.vlan_id}`);
        if (pyTruthy(s.ip_cidr)) {
            const [ip, prefix] = s.ip_cidr.split("/");
            const mask = prefix_to_mask(parseInt(prefix, 10));
            lines.push(` ip address ${ip} ${mask}`);
        }
        const v6 = (interfaces_v6 || {})[`${s.parent_port}.${s.vlan_id}`];
        if (pyTruthy(v6)) {
            lines.push(` ipv6 address ${v6}`);
            lines.push(" ipv6 enable");
        }
        lines.push(" exit");
    }
    return lines;
}

function _wrap_payload(body) {
    const lines = ["enable", "configure terminal"];
    lines.push(...body);
    lines.push("end");
    lines.push("write memory");
    return lines.join("\n");
}

export function build_switch_vlan_payload(
    vlans, access_ports, trunks, supports_encap = false
) {
    return _wrap_payload(
        generate_switch_vlan_cli(vlans, access_ports, trunks, supports_encap)
    );
}

export function build_router_subinterface_payload(subinterfaces) {
    return _wrap_payload(generate_router_subinterface_cli(subinterfaces));
}

export function build_vlan_js_call(device, ios_payload) {
    // Wraps the IOS payload in `configureIosDevice` as a single JS line.
    // json.dumps per value: it also escapes \r, U+2028/2029 and control
    // characters, which the old hand-written escaping let through.
    return `configureIosDevice(${pyJsonDumps(device)}, ${pyJsonDumps(ios_payload)});`;
}
