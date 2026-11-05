// Cisco CME voice: `telephony-service` + `ephone-dn` on a router, voice VLAN on a switch.

function _wrapList(cls, v) {
    return (v || []).map((x) => (x instanceof cls ? x : new cls(x)));
}
function _dictList(v) { return (v || []).map((x) => (x && typeof x.toDict === "function" ? x.toDict() : x)); }
function _int(v) { return typeof v === "string" ? parseInt(v, 10) : v; }
function _intOrNull(v) {
    if (v === null || v === undefined) return null;
    return _int(v);
}

const _HEX12 = /^[0-9A-Fa-f]{12}$/;

export function normalize_mac(text) {
    /** '00:01:43:21:ab:cd', '0001.4321.ABCD' or '00-01-...' → '0001.4321.ABCD'; else None. */
    if (!text) {
        return null;
    }
    const raw0 = text.trim().replace(/[.:\-]/g, "");
    if (!_HEX12.test(raw0)) {
        return null;
    }
    const raw = raw0.toUpperCase();
    return `${raw.slice(0, 4)}.${raw.slice(4, 8)}.${raw.slice(8, 12)}`;
}

export class VoiceExtension {
    /** One directory number (`ephone-dn`). With `mac`, a static `ephone` gets it on button 1. */
    constructor(obj = {}) {
        this.number = obj.number !== undefined ? obj.number : undefined;
        this.mac = obj.mac !== undefined ? obj.mac : null;
    }
    toDict() { return { number: this.number, mac: this.mac }; }
}

export class VoiceConfig {
    /** CME on `router`, plus the optional voice VLAN and DHCP option 150 for the phones. */
    constructor(obj = {}) {
        this.router = obj.router !== undefined ? obj.router : undefined;
        this.source_ip = obj.source_ip !== undefined ? obj.source_ip : undefined;
        this.source_port = obj.source_port !== undefined ? _int(obj.source_port) : 2000;
        this.max_ephones = obj.max_ephones !== undefined ? _int(obj.max_ephones) : 5;
        this.max_dn = obj.max_dn !== undefined ? _int(obj.max_dn) : 5;
        this.extensions = obj.extensions !== undefined ? _wrapList(VoiceExtension, obj.extensions) : [];
        this.auto_assign = obj.auto_assign !== undefined ? obj.auto_assign : true;
        this.voice_vlan = obj.voice_vlan !== undefined ? _intOrNull(obj.voice_vlan) : null;
        this.switch = obj.switch !== undefined ? obj.switch : null;
        this.access_ports = obj.access_ports !== undefined ? [...obj.access_ports] : [];
        this.dhcp_pool = obj.dhcp_pool !== undefined ? obj.dhcp_pool : null;
        this.dhcp_network = obj.dhcp_network !== undefined ? obj.dhcp_network : null;
    }
    toDict() {
        return {
            router: this.router, source_ip: this.source_ip, source_port: this.source_port,
            max_ephones: this.max_ephones, max_dn: this.max_dn, extensions: _dictList(this.extensions),
            auto_assign: this.auto_assign, voice_vlan: this.voice_vlan, switch: this.switch,
            access_ports: [...this.access_ports], dhcp_pool: this.dhcp_pool, dhcp_network: this.dhcp_network,
        };
    }
}
