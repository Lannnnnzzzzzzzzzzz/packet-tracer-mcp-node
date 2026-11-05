// CLI generator for per-interface fine-tuning.

import { pyJsonDumps } from "../../shared/pycompat.js";

function _is_serial(cfg) {
    // Port of InterfaceTuning.is_serial() in domain/models/interface_tuning.py:
    // the model port may or may not carry the method, so fall back to its body.
    if (typeof cfg.is_serial === "function") return cfg.is_serial();
    return String(cfg.interface).toLowerCase().startsWith("serial");
}

export function generate_interface_tuning_cli(cfg) {
    const lines = [`interface ${cfg.interface}`];
    if (cfg.bandwidth !== null && cfg.bandwidth !== undefined) {
        lines.push(` bandwidth ${cfg.bandwidth}`);
    }
    if (cfg.clock_rate !== null && cfg.clock_rate !== undefined && _is_serial(cfg)) {
        lines.push(` clock rate ${cfg.clock_rate}`);
    }
    if (cfg.delay !== null && cfg.delay !== undefined) {
        lines.push(` delay ${cfg.delay}`);
    }
    if (cfg.ospf_cost !== null && cfg.ospf_cost !== undefined) {
        lines.push(` ip ospf cost ${cfg.ospf_cost}`);
    }
    if (cfg.ospf_priority !== null && cfg.ospf_priority !== undefined) {
        lines.push(` ip ospf priority ${cfg.ospf_priority}`);
    }
    if (cfg.ospf_hello_interval !== null && cfg.ospf_hello_interval !== undefined) {
        lines.push(` ip ospf hello-interval ${cfg.ospf_hello_interval}`);
    }
    if (cfg.ospf_dead_interval !== null && cfg.ospf_dead_interval !== undefined) {
        lines.push(` ip ospf dead-interval ${cfg.ospf_dead_interval}`);
    }
    if (cfg.ospf_network !== null && cfg.ospf_network !== undefined) {
        lines.push(` ip ospf network ${cfg.ospf_network}`);
    }
    // The key goes BEFORE enabling authentication: in reverse, the interface would
    // require auth without anything to answer with, and the neighbor would drop.
    if (cfg.ospf_md5_key !== null && cfg.ospf_md5_key !== undefined) {
        lines.push(
            ` ip ospf message-digest-key ${cfg.ospf_md5_key_id} md5 ${cfg.ospf_md5_key}`
        );
        lines.push(" ip ospf authentication message-digest");
    } else if (cfg.ospf_auth_key !== null && cfg.ospf_auth_key !== undefined) {
        lines.push(` ip ospf authentication-key ${cfg.ospf_auth_key}`);
        lines.push(" ip ospf authentication");
    }
    lines.push(" exit");
    return lines;
}

export function build_interface_tuning_payload(cfg) {
    return ["enable", "configure terminal", ...generate_interface_tuning_cli(cfg),
         "end", "write memory"].join("\n");
}

// PT 9.0.1 flushes a router's own type-5 default LSA when an OSPF interface setting
// resets its adjacency (verified with `ip ospf network point-to-point` on an ASBR) and
// never re-originates it: the whole network loses its default route without an error.
// After such a change, re-enter every `default-information originate` line found in
// the router's startup-config (configureIosDevice ends with `write memory`, so it is
// current). A router that never originated a default is left untouched.
export const REORIGINATE_OSPF_DEFAULT_JS = (
    String.raw`function reoriginateOspfDefault(name){`
    + String.raw`var d=ipc.network().getDevice(name);`
    + String.raw`if(!d||typeof d.getStartupFile!=='function')return 0;`
    // getStartupFile() returns an ARRAY of lines (String() of it joins them with commas).
    + String.raw`var f=d.getStartupFile()||[];`
    + String.raw`var lines=(typeof f==='string')?f.split('\n'):Array.prototype.slice.call(f);var pid=null,n=0;`
    + String.raw`for(var i=0;i<lines.length;i++){var ln=String(lines[i]).replace(/\r$/,'');`
    + String.raw`var m=/^router ospf (\d+)/.exec(ln);if(m){pid=m[1];continue;}`
    + String.raw`if(!/^ /.test(ln)){pid=null;continue;}`
    + String.raw`var t=ln.trim();`
    + String.raw`if(pid&&t.indexOf('default-information originate')===0){`
    + String.raw`d.enterCommand('!','global');d.enterCommand('router ospf '+pid,'');`
    + String.raw`d.enterCommand('no '+t,'');d.enterCommand(t,'');d.enterCommand('end','');n++;}}`
    + String.raw`return n;}`
);

export function build_interface_tuning_js_call(device, ios_payload, ospf_changed = false) {
    // json.dumps per field (AGENTS.md rule 1); it also escapes the payload's line breaks.
    let call = `configureIosDevice(${pyJsonDumps(device)}, ${pyJsonDumps(ios_payload)});`;
    if (ospf_changed) {
        call = REORIGINATE_OSPF_DEFAULT_JS + call + `reoriginateOspfDefault(${pyJsonDumps(device)});`;
    }
    return call;
}
