// Generador CLI para STP y port-security.

import { pyJsonDumps, pyTruthy } from "../../shared/pycompat.js";

export function generate_stp_cli(cfg) {
    const lines = [`spanning-tree mode ${cfg.mode}`];
    for (const vlan of cfg.root_primary_vlans) {
        lines.push(`spanning-tree vlan ${vlan} root primary`);
    }
    // Python: cfg.priority.items() — dict[int, int]. A JS Map iterates in
    // insertion order like Python; a plain object with integer-like keys
    // iterates numerically (see CONVENTIONS.md).
    const prioEntries = cfg.priority instanceof Map
        ? [...cfg.priority.entries()]
        : Object.entries(cfg.priority || {});
    for (const [vlan, prio] of prioEntries) {
        lines.push(`spanning-tree vlan ${vlan} priority ${prio}`);
    }
    for (const port of cfg.portfast_ports) {
        lines.push(`interface ${port}`);
        lines.push(" spanning-tree portfast");
        lines.push(" exit");
    }
    for (const port of cfg.bpduguard_ports) {
        lines.push(`interface ${port}`);
        lines.push(" spanning-tree bpduguard enable");
        lines.push(" exit");
    }
    return lines;
}

export function generate_port_security_cli(cfg) {
    const lines = [
        `interface ${cfg.port}`,
        " switchport mode access",
        " switchport port-security",
        ` switchport port-security maximum ${cfg.max_mac}`,
        ` switchport port-security violation ${cfg.violation}`,
    ];
    if (cfg.sticky) {
        lines.push(" switchport port-security mac-address sticky");
    }
    for (const mac of cfg.static_macs) {
        lines.push(` switchport port-security mac-address ${mac}`);
    }
    lines.push(" exit");
    return lines;
}

function _wrap(body) {
    return ["enable", "configure terminal", ...body, "end", "write memory"].join("\n");
}

export function build_stp_payload(cfg) {
    return _wrap(generate_stp_cli(cfg));
}

export function build_port_security_payload(cfg) {
    return _wrap(generate_port_security_cli(cfg));
}

export function build_switch_js_call(device, ios_payload) {
    // json.dumps per value: it also escapes \r, U+2028/2029 and control
    // characters, which the old hand-written escaping let through.
    return `configureIosDevice(${pyJsonDumps(device)}, ${pyJsonDumps(ios_payload)});`;
}
