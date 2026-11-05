// Python-semantics helpers: the port's fidelity layer.
//
// The Python original leans on CPython behaviours that JavaScript does not
// share (json.dumps formatting, round-half-even, truthiness of empty
// collections, float repr). Every module in this port uses these helpers
// instead of the JS defaults wherever the Python code relied on them.

/** Python json.dumps string escaping (ensure_ascii path). */
function pyEscapeString(s, ensureAscii) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (cp < 0x20) out += '\\u' + cp.toString(16).padStart(4, '0');
    else if (ensureAscii && cp > 0x7e) {
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        out += '\\u' + (0xd800 + (v >> 10)).toString(16).padStart(4, '0');
        out += '\\u' + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
      } else {
        out += '\\u' + cp.toString(16).padStart(4, '0');
      }
    } else out += ch;
  }
  return out + '"';
}

/**
 * Python repr of a float: shortest round-trip, but CPython switches to
 * exponential notation below 1e-4 and at/above 1e16, and always shows a
 * decimal point or exponent (repr(2.0) == '2.0').
 */
export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const ax = Math.abs(x);
  let s = String(x); // JS shortest round-trip, like Python's float_repr
  if (s.includes('e') || s.includes('E')) {
    // Python: exponent has a sign and at least two digits: 1e-05, 1.5e+16.
    let [mant, exp] = s.split(/[eE]/);
    let e = parseInt(exp, 10);
    if (ax >= 1e-4 && ax < 1e16) {
      // Python would not use exponential here; expand.
      return expandExponential(mant, e);
    }
    if (!mant.includes('.')) mant += '.0';
    const sign = e < 0 ? '-' : '+';
    return `${mant}e${sign}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  if (ax !== 0 && (ax < 1e-4 || ax >= 1e16)) {
    // JS printed decimal, Python wants exponential.
    const exp = Math.floor(Math.log10(ax));
    let mant = x / Math.pow(10, exp);
    let ms = String(mant);
    if (!ms.includes('.')) ms += '.0';
    const sign = exp < 0 ? '-' : '+';
    return `${ms}e${sign}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (!s.includes('.')) s += '.0';
  return s;
}

function expandExponential(mant, e) {
  const neg = mant.startsWith('-');
  const m = neg ? mant.slice(1) : mant;
  const digits = m.replace('.', '');
  const intDigits = (m.split('.')[0] || '').length;
  const point = intDigits + e;
  let out;
  if (point <= 0) out = '0.' + '0'.repeat(-point) + digits;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length) + '.0';
  else out = digits.slice(0, point) + '.' + digits.slice(point);
  return (neg ? '-' : '') + out;
}

/**
 * A float value that must serialize like a Python float (repr in JSON and in
 * string contexts) even when it is integral — JS numbers cannot distinguish
 * 3 from 3.0, Python floats can. Arithmetic works via valueOf().
 */
export class PyFloat {
  constructor(v) { this.v = v; }
  valueOf() { return this.v; }
  toString() { return pyFloatRepr(this.v); }
  [Symbol.toPrimitive](hint) { return hint === 'string' ? pyFloatRepr(this.v) : this.v; }
}

/**
 * Python json.dumps.
 * opts: { ensureAscii = true, separators = null (→ [', ', ': '], or [',', ': ']
 * when indent is set), indent = null, sortKeys = false }
 */
export function pyJsonDumps(value, opts = {}) {
  const ensureAscii = opts.ensureAscii !== undefined ? opts.ensureAscii : true;
  const indent = opts.indent !== undefined ? opts.indent : null;
  const sortKeys = !!opts.sortKeys;
  let itemSep, keySep;
  if (opts.separators) [itemSep, keySep] = opts.separators;
  else if (indent !== null) { itemSep = ','; keySep = ': '; }
  else { itemSep = ', '; keySep = ': '; }

  function dump(v, level) {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (v instanceof PyFloat) return pyFloatRepr(v.v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return 'null'; // Python raises; MCP data never has these
      return Number.isInteger(v) && Math.abs(v) < 1e21 ? String(v) : pyFloatRepr(v);
    }
    if (typeof v === 'string') return pyEscapeString(v, ensureAscii);
    const pad = indent !== null ? '\n' + ' '.repeat(indent * (level + 1)) : '';
    const closePad = indent !== null ? '\n' + ' '.repeat(indent * level) : '';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      const parts = v.map((item) => dump(item, level + 1));
      return '[' + pad + parts.join(itemSep + pad) + closePad + ']';
    }
    if (typeof v === 'object') {
      let keys = Object.keys(v);
      if (sortKeys) keys = keys.sort();
      keys = keys.filter((k) => v[k] !== undefined);
      if (!keys.length) return '{}';
      const parts = keys.map((k) => pyEscapeString(String(k), ensureAscii) + keySep + dump(v[k], level + 1));
      return '{' + pad + parts.join(itemSep + pad) + closePad + '}';
    }
    return pyEscapeString(String(v), ensureAscii);
  }
  return dump(value, 0);
}

/** Python round(): round-half-even. Returns int when ndigits is undefined. */
export function pyRound(x, ndigits) {
  if (ndigits === undefined) {
    const f = Math.floor(x);
    const diff = x - f;
    let r;
    if (diff > 0.5) r = f + 1;
    else if (diff < 0.5) r = f;
    else r = (f % 2 === 0) ? f : f + 1; // tie: to even
    return r;
  }
  const p = Math.pow(10, ndigits);
  const scaled = x * p;
  const f = Math.floor(scaled);
  const diff = scaled - f;
  let r;
  if (diff > 0.5) r = f + 1;
  else if (diff < 0.5) r = f;
  else r = (Math.abs(f) % 2 === 0) ? f : f + 1;
  return new PyFloat(r / p); // Python round(x, n) returns a float
}

/** Python truthiness: '', [], {}, 0, 0.0, null/None, false are falsy. */
export function pyTruthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** Python str() for the value types this codebase stringifies. */
export function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v instanceof PyFloat) return pyFloatRepr(v.v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (typeof v === 'object') {
    const parts = Object.entries(v).map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`);
    return '{' + parts.join(', ') + '}';
  }
  return String(v);
}

/** Python repr() for common value types. */
export function pyRepr(v) {
  if (typeof v === 'string') {
    const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
    let body = v.replace(/\\/g, '\\\\');
    if (quote === "'") body = body.replace(/'/g, "\\'");
    body = body.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    return quote + body + quote;
  }
  return pyStr(v);
}

/** Python floor division and modulo (sign follows the divisor). */
export function pyFloorDiv(a, b) { return Math.floor(a / b); }
export function pyMod(a, b) { return ((a % b) + b) % b; }

/** IPv4 helpers standing in for the pieces of `ipaddress` this code uses. */
export function ipToInt(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) + (parseInt(part, 10) & 0xff)) >>> 0, 0) >>> 0;
}
export function intToIp(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

/** Sleep helper (Python time.sleep in async code paths). */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Monotonic clock in seconds, like Python time.monotonic(). */
export function monotonic() {
  return performance.now() / 1000;
}
