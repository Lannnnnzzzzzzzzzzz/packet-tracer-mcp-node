// CLI generator for HSRP, BGP and QoS (MQC) on a router.
//
// Every line shape here was measured on a 2911 in PT 9: status 0 from enterCommand and
// present in `show running-config` (BGP shows a classful network without `mask`).

import { pyJsonDumps, pyStr } from "../../shared/pycompat.js";
import { IPv4Address, IPv4Network } from "../../shared/ipnet.js";

// The use case renders the CLI even for an invalid config (it is shown next to the
// errors), so these fall back to the raw text instead of raising.
function _ip(text) {
    try {
        return String(new IPv4Address(text.trim()));
    } catch (e) {
        return text.trim();
    }
}

function _network_mask(text) {
    let net;
    try {
        net = new IPv4Network(text.trim());
        // Python IPv4Network(text) is strict: host bits set raises ValueError.
        // ipnet.js masks silently, so check strictness explicitly.
        const addr = new IPv4Address(text.trim().split("/")[0]);
        if (String(addr) !== String(net.network_address) && text.trim().includes("/")) {
            // Only a host-bits mismatch on a CIDR input is a strict failure;
            // a plain address is its own /32 network in Python too.
            if (parseInt(text.trim().split("/")[1], 10) !== 32) {
                return text.trim();
            }
        }
    } catch (e) {
        return text.trim();
    }
    return `${net.network_address} mask ${net.netmask}`;
}

export function generate_hsrp_cli(cfg) {
    const g = cfg.group;
    const lines = [
        `interface ${cfg.interface.trim()}`,
        ` standby version ${cfg.version}`,
        ` standby ${g} ip ${_ip(cfg.virtual_ip)}`,
        ` standby ${g} priority ${cfg.priority}`,
    ];
    if (cfg.preempt) {
        lines.push(` standby ${g} preempt`);
    }
    lines.push(" exit");
    return lines;
}

export function generate_bgp_cli(cfg) {
    const lines = [`router bgp ${cfg.asn}`];
    for (const n of cfg.neighbors) {
        lines.push(` neighbor ${_ip(n.ip)} remote-as ${n.remote_as}`);
    }
    for (const text of cfg.networks) {
        lines.push(` network ${_network_mask(text)}`);
    }
    lines.push(" exit");
    return lines;
}

export function generate_qos_cli(cfg) {
    const lines = [];
    for (const c of cfg.classes) {
        lines.push(`class-map match-any ${c.name}`);
        if (c.match_protocol !== null && c.match_protocol !== undefined) {
            lines.push(` match protocol ${pyStr(c.match_protocol).trim().toLowerCase()}`);
        }
        if (c.match_dscp !== null && c.match_dscp !== undefined) {
            lines.push(` match ip dscp ${pyStr(c.match_dscp).trim().toLowerCase()}`);
        }
        lines.push(" exit");
    }
    lines.push(`policy-map ${cfg.policy_name}`);
    for (const c of cfg.classes) {
        lines.push(` class ${c.name}`);
        if (c.priority_kbps !== null && c.priority_kbps !== undefined) {
            lines.push(`  priority ${c.priority_kbps}`);
        } else {
            lines.push(`  bandwidth ${c.bandwidth_kbps}`);
        }
        lines.push("  exit");
    }
    lines.push(" class class-default", "  fair-queue", "  exit", " exit");
    lines.push(`interface ${cfg.interface.trim()}`,
              ` service-policy ${cfg.direction} ${cfg.policy_name}`,
              " exit");
    return lines;
}

export function wrap_ios_payload(body) {
    return ["enable", "configure terminal", ...body, "end", "write memory"].join("\n");
}

export function build_ios_js_call(device, ios_payload) {
    // json.dumps per field (AGENTS.md rule 1); it also escapes the payload's line breaks.
    return `configureIosDevice(${pyJsonDumps(device)}, ${pyJsonDumps(ios_payload)});`;
}
