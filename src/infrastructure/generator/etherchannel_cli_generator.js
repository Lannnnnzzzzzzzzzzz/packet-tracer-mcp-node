// CLI generator for EtherChannel on a switch.
//
// Measured on a 2960-24TT in PT 9: `interface range FastEthernet0/10 - 11`,
// `channel-group <n> mode <mode>`, then `interface Port-channel<n>` +
// `switchport mode trunk`; `show etherchannel summary` lists the group.

const _PORT_RE = /^(.*?)(\d+)$/;

function _as_range(ports) {
    // 'FastEthernet0/10 - 11' when the ports are one contiguous run on one module.
    const parts = ports.map((p) => { const m = _PORT_RE.exec(p); return m && m[0] === p ? m : null; });
    if (ports.length < 2 || !parts.every(Boolean)) {
        return null;
    }
    const prefixes = new Set(parts.map((m) => m[1]));
    const numbers = parts.map((m) => parseInt(m[2], 10)).sort((a, b) => a - b);
    const expected = Array.from({ length: numbers.length }, (_, i) => numbers[0] + i);
    if (prefixes.size !== 1 || numbers.join(",") !== expected.join(",")) {
        return null;
    }
    return `${[...prefixes][0]}${numbers[0]} - ${numbers[numbers.length - 1]}`;
}

export function generate_etherchannel_cli(cfg) {
    const member = [` channel-group ${cfg.group} mode ${cfg.mode}`, " exit"];
    const run = _as_range(cfg.ports);
    const lines = [];
    if (run) {
        lines.push(`interface range ${run}`, ...member);
    } else {
        for (const port of cfg.ports) {
            lines.push(`interface ${port}`, ...member);
        }
    }
    lines.push(`interface Port-channel${cfg.group}`);
    if (cfg.trunk) {
        lines.push(" switchport mode trunk");
        if (cfg.allowed_vlans && cfg.allowed_vlans.length) {
            const allowed = [...new Set(cfg.allowed_vlans)].sort((a, b) => a - b).map(String).join(",");
            lines.push(` switchport trunk allowed vlan ${allowed}`);
        }
    }
    lines.push(" exit");
    return lines;
}
