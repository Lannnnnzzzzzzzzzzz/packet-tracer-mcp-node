// Minimal stand-in for Python's `ipaddress` module, covering the surface this
// codebase uses: IPv4Network / IPv4Address / IPv6Network / IPv6Address,
// ip_network / ip_address / ip_interface factories.

import { ipToInt, intToIp } from "./pycompat.js";

export class IPv4Address {
    constructor(value) {
        if (typeof value === "number") this._int = value >>> 0;
        else if (value instanceof IPv4Address) this._int = value._int;
        else {
            const parts = String(value).trim().split(".");
            if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p) || +p > 255)) {
                throw new Error(`'${value}' does not appear to be an IPv4 address`);
            }
            this._int = ipToInt(String(value).trim());
        }
    }
    toString() { return intToIp(this._int); }
    valueOf() { return this._int; }
    [Symbol.toPrimitive](hint) { return hint === "string" ? this.toString() : this._int; }
    get exploded() { return this.toString(); }
    get compressed() { return this.toString(); }
    get is_loopback() { return (this._int >>> 24) === 127; }
    get is_multicast() { const o = this._int >>> 24; return o >= 224 && o <= 239; }
    get is_reserved() { const o = this._int >>> 24; return o === 0 || o >= 240; }
    get is_link_local() { return (this._int >>> 16) === 0xA9FE; }
    get is_private() {
        const o1 = this._int >>> 24, o2 = (this._int >>> 16) & 0xff;
        return o1 === 10 || o1 === 127 || (o1 === 172 && o2 >= 16 && o2 <= 31)
            || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254)
            || (o1 === 192 && o2 === 0) || (o1 === 198 && (o2 === 18 || o2 === 19))
            || o1 === 0 || (o1 === 100 && o2 >= 64 && o2 <= 127);
    }
    get is_global() { return !this.is_private; }
    add(n) { return new IPv4Address((this._int + n) >>> 0); }
    cmp(other) { const o = other instanceof IPv4Address ? other._int : ipToInt(String(other)); return this._int - o; }
    eq(other) { return this.cmp(other) === 0; }
}

function maskFromPrefix(prefix) {
    if (prefix === 0) return 0;
    return (0xFFFFFFFF << (32 - prefix)) >>> 0;
}

export class IPv4Network {
    /** Accepts "a.b.c.d/p" (or a dotted mask), an IPv4Address + prefix, or int + prefix.
     * Python's strict mode raises when host bits are set; most call sites here
     * pass strict=False semantics, so host bits are masked off silently. */
    constructor(addr, prefix = null) {
        let ipInt, pfx;
        if (addr instanceof IPv4Network) { this._net = addr._net; this.prefixlen = addr.prefixlen; return; }
        if (typeof addr === "string" && addr.includes("/")) {
            const [ipPart, pPart] = addr.split("/");
            ipInt = ipToInt(ipPart);
            if (pPart.includes(".")) {
                pfx = (ipToInt(pPart) >>> 0).toString(2).replace(/0/g, "").length;
            } else pfx = parseInt(pPart, 10);
        } else if (typeof addr === "number") {
            ipInt = addr >>> 0; pfx = prefix;
        } else {
            ipInt = new IPv4Address(addr)._int; pfx = prefix;
        }
        if (pfx === null || pfx === undefined) pfx = 32;
        this.prefixlen = pfx;
        this._net = (ipInt & maskFromPrefix(pfx)) >>> 0;
    }
    get network_address() { return new IPv4Address(this._net); }
    get broadcast_address() { return new IPv4Address((this._net | (~maskFromPrefix(this.prefixlen) >>> 0)) >>> 0); }
    get netmask() { return new IPv4Address(maskFromPrefix(this.prefixlen)); }
    get hostmask() { return new IPv4Address((~maskFromPrefix(this.prefixlen)) >>> 0); }
    get num_addresses() { return Math.pow(2, 32 - this.prefixlen); }
    toString() { return `${intToIp(this._net)}/${this.prefixlen}`; }
    [Symbol.toPrimitive](hint) { return hint === "string" ? this.toString() : this._net; }
    /** Python `ip in network`. */
    contains(ip) {
        const v = ip instanceof IPv4Address ? ip._int : ipToInt(String(ip));
        return ((v & maskFromPrefix(this.prefixlen)) >>> 0) === this._net;
    }
    overlaps(other) {
        const o = other instanceof IPv4Network ? other : new IPv4Network(String(other));
        return this.contains(o.network_address) || this.contains(o.broadcast_address)
            || o.contains(this.network_address) || o.contains(this.broadcast_address);
    }
    subnet_of(other) {
        const o = other instanceof IPv4Network ? other : new IPv4Network(String(other));
        return o.contains(this.network_address) && o.contains(this.broadcast_address);
    }
    supernet_of(other) {
        const o = other instanceof IPv4Network ? other : new IPv4Network(String(other));
        return this.contains(o.network_address) && this.contains(o.broadcast_address);
    }
    eq(other) { const o = other instanceof IPv4Network ? other : new IPv4Network(String(other)); return this._net === o._net && this.prefixlen === o.prefixlen; }
    /** Usable host addresses (Python .hosts()): /31 yields both, /32 the one. */
    hosts() {
        const out = [];
        const start = this.prefixlen >= 31 ? this._net : this._net + 1;
        const end = this.prefixlen >= 31 ? this.broadcast_address._int : this.broadcast_address._int - 1;
        for (let v = start; v <= end; v++) out.push(new IPv4Address(v));
        return out;
    }
    /** Subnets with the given new prefix (Python .subnets(new_prefix=...)). */
    subnets(new_prefix) {
        const out = [];
        if (new_prefix < this.prefixlen) throw new Error("new prefix must be longer");
        const step = Math.pow(2, 32 - new_prefix);
        const count = Math.pow(2, new_prefix - this.prefixlen);
        for (let i = 0; i < count; i++) out.push(new IPv4Network((this._net + i * step) >>> 0, new_prefix));
        return out;
    }
    supernet(new_prefix = null) {
        const p = new_prefix === null ? this.prefixlen - 1 : new_prefix;
        return new IPv4Network(this._net, p);
    }
    address_at(n) { return new IPv4Address((this._net + n) >>> 0); }
}

// ---- IPv6 (light: parsing, formatting, prefix math; used by dual-stack planning) ----

function parseIPv6(str) {
    let s = String(str).trim();
    let v4tail = null;
    if (s.includes(".")) {
        const idx = s.lastIndexOf(":");
        v4tail = ipToInt(s.slice(idx + 1));
        s = s.slice(0, idx + 1) + "0:0";
    }
    const halves = s.split("::");
    if (halves.length > 2) throw new Error(`invalid IPv6: ${str}`);
    const left = halves[0] ? halves[0].split(":").map((h) => parseInt(h, 16)) : [];
    const right = halves.length === 2 ? (halves[1] ? halves[1].split(":").map((h) => parseInt(h, 16)) : []) : null;
    let groups;
    if (right === null) groups = left;
    else groups = [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
    if (groups.length !== 8) throw new Error(`invalid IPv6: ${str}`);
    if (v4tail !== null) { groups[6] = (v4tail >>> 16) & 0xffff; groups[7] = v4tail & 0xffff; }
    let v = 0n;
    for (const g of groups) v = (v << 16n) | BigInt(g & 0xffff);
    return v;
}

function formatIPv6(v) {
    const groups = [];
    for (let k = 0; k < 8; k++) groups.push(Number((v >> BigInt((7 - k) * 16)) & 0xffffn));
    // RFC 5952-ish compression: longest run of >=2 zero groups (Python compresses >=1? CPython compresses runs of 2+; single 0 stays).
    let bestStart = -1, bestLen = 1;
    let curStart = -1, curLen = 0;
    for (let i = 0; i < 8; i++) {
        if (groups[i] === 0) { if (curStart < 0) curStart = i; curLen++; if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; } }
        else { curStart = -1; curLen = 0; }
    }
    const hex = groups.map((g) => g.toString(16));
    if (bestStart >= 0 && bestLen >= 2) {
        const left = hex.slice(0, bestStart).join(":");
        const right = hex.slice(bestStart + bestLen).join(":");
        return `${left}::${right}`;
    }
    return hex.join(":");
}

export class IPv6Address {
    constructor(value) {
        if (typeof value === "bigint") this._v = value;
        else if (typeof value === "number") this._v = BigInt(value);
        else if (value instanceof IPv6Address) this._v = value._v;
        else this._v = parseIPv6(value);
    }
    toString() { return formatIPv6(this._v); }
    get exploded() {
        const groups = [];
        for (let k = 0; k < 8; k++) groups.push(((this._v >> BigInt((7 - k) * 16)) & 0xffffn).toString(16).padStart(4, "0"));
        return groups.join(":");
    }
    get compressed() { return this.toString(); }
    get is_loopback() { return this._v === 1n; }
    get is_multicast() { return (this._v >> 120n) === 0xffn; }
    get is_link_local() { return (this._v >> 118n) === 0b1111111010n; }
    get is_private() { return (this._v >> 120n) === 0xfcn || (this._v >> 120n) === 0xfdn || this.is_link_local || this.is_loopback; }
    get is_reserved() { return (this._v >> 120n) === 0n && this._v !== 1n; }
    get is_global() { return !this.is_private; }
    add(n) { return new IPv6Address(this._v + BigInt(n)); }
    cmp(other) { const o = other instanceof IPv6Address ? other._v : parseIPv6(String(other)); return this._v < o ? -1 : this._v > o ? 1 : 0; }
    eq(other) { return this.cmp(other) === 0; }
}

export class IPv6Network {
    constructor(addr, prefix = null) {
        let v, pfx;
        if (addr instanceof IPv6Network) { this._v = addr._v; this.prefixlen = addr.prefixlen; return; }
        if (typeof addr === "string" && addr.includes("/")) {
            const [ipPart, pPart] = addr.split("/");
            v = parseIPv6(ipPart); pfx = parseInt(pPart, 10);
        } else if (typeof addr === "bigint") { v = addr; pfx = prefix; }
        else { v = new IPv6Address(addr)._v; pfx = prefix; }
        if (pfx === null || pfx === undefined) pfx = 128;
        this.prefixlen = pfx;
        const mask = pfx === 0 ? 0n : ((1n << BigInt(pfx)) - 1n) << BigInt(128 - pfx);
        this._mask = mask;
        this._v = v & mask;
    }
    get network_address() { return new IPv6Address(this._v); }
    get netmask() { return new IPv6Address(this._mask); }
    get num_addresses() { return 2n ** BigInt(128 - this.prefixlen); }
    toString() { return `${formatIPv6(this._v)}/${this.prefixlen}`; }
    [Symbol.toPrimitive](hint) { return hint === "string" ? this.toString() : 0; }
    contains(ip) {
        const v = ip instanceof IPv6Address ? ip._v : parseIPv6(String(ip));
        return (v & this._mask) === this._v;
    }
    overlaps(other) {
        const o = other instanceof IPv6Network ? other : new IPv6Network(String(other));
        return this.contains(o.network_address) || o.contains(this.network_address);
    }
    subnet_of(other) {
        const o = other instanceof IPv6Network ? other : new IPv6Network(String(other));
        return o.contains(this.network_address) && this.prefixlen >= o.prefixlen;
    }
    eq(other) { const o = other instanceof IPv6Network ? other : new IPv6Network(String(other)); return this._v === o._v && this.prefixlen === o.prefixlen; }
    hosts() { return [this.network_address]; } // rarely used for v6 here
    subnets(new_prefix) {
        const out = [];
        const step = 1n << BigInt(128 - new_prefix);
        const count = Math.pow(2, new_prefix - this.prefixlen);
        for (let i = 0; i < count; i++) out.push(new IPv6Network(this._v + BigInt(i) * step, new_prefix));
        return out;
    }
    address_at(n) { return new IPv6Address(this._v + BigInt(n)); }
}

/** Python ipaddress.ip_network(value, strict=False). */
export function ip_network(value, strict = false) {
    const s = String(value);
    return s.includes(":") ? new IPv6Network(s) : new IPv4Network(s);
}

/** Python ipaddress.ip_address(value). */
export function ip_address(value) {
    if (typeof value === "number") return new IPv4Address(value);
    const s = String(value);
    return s.includes(":") ? new IPv6Address(s) : new IPv4Address(s);
}

/** Python ipaddress.ip_interface(value): address + its network. */
export function ip_interface(value) {
    const s = String(value);
    const isV6 = s.includes(":");
    const net = isV6 ? new IPv6Network(s) : new IPv4Network(s);
    const addr = isV6 ? new IPv6Address(s.split("/")[0]) : new IPv4Address(s.split("/")[0]);
    return {
        ip: addr,
        network: net,
        netmask: net.netmask,
        prefixlen: net.prefixlen,
        toString() { return `${addr.toString()}/${net.prefixlen}`; },
    };
}
