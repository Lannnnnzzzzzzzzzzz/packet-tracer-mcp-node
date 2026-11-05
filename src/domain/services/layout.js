// Topology-aware layout that fits the Packet Tracer canvas.
//
// The old layout put every router on one row, every switch on the next and every host on
// the last, whatever the topology: 3 routers with 3 PCs looked like 2 routers with 2 PCs,
// and a triangle's closing link ran behind the middle router. This module reads the graph
// instead:
//
// 1. The **core** (routers; with no router, the busiest switch) gets a shape from its own
//    links: a pair or a chain is a horizontal line, a ring is a regular polygon, a hub with
//    spokes is a star, anything else a circle.
// 2. Each core device gets an **outward direction**: away from the centre of the shape. In
//    a line the ends point left and right and the middle ones alternate down and up, so
//    2 routers with 2 PCs each draw as PCs | R1 —— R2 | PCs.
// 3. Everything hanging from a core device (switch → hosts, AP, secondary switch, cloud)
//    is a **branch** drawn as a small tree along that direction: the switch first, its
//    hosts side by side across the direction, wrapped into rows when there are many.
//    Several branches of one router sit in parallel, each with the room it needs.
// 4. The drawing is **fitted to the canvas** (the visible area of PT's logical view, which
//    depends on the screen: 1512x599 on a 14" MacBook, about 1900x700 on 1920x1080): scaled
//    to fill it without spreading a small lab across a huge screen, and centred.
//
// Everything works on names, categories and links, so the same function lays out a plan
// before the deploy and a live canvas read back from PT.

import { pyRound, pyTruthy, PyFloat } from "../../shared/pycompat.js";

// Visible logical-view area used when the real one cannot be read (no bridge): the
// smallest common case, a 14" MacBook with PT maximised (measured 1512x599).
export const DEFAULT_CANVAS = [1500, 600];

// A device icon is about 50 px wide; with its two label lines (model, name) it is about
// 65 px tall. PT anchors a device at the top-left corner of its icon.
export const ICON_W = 50;
export const ICON_H = 40;
export const LABEL_H = 25;
export const MARGIN = 45;

// Distances of the unscaled drawing (the fit scales them).
export const CORE_GAP = 260;        // between neighbouring core devices
export const FIRST_HOP = 120;       // core device → first device of a branch
export const NEXT_HOP = 130;        // one tree level further
export const SPREAD_X = 95;         // side by side, horizontally
export const SPREAD_Y = 95;         // side by side, vertically (the labels take room)
export const ROW_MAX = 6;           // hosts in one row before wrapping

// Never shrink below this (labels overlap) and never blow a small lab up past this.
export const SCALE_MIN = 0.7;
export const SCALE_MAX = 1.2;
export const MAX_STRETCH = 1.5;     // one axis at most this many times the other

const _COMPASS = [-90, 0, 180, 90, -45, -135, 45, 135].map((a) => a * Math.PI / 180);

const _HOSTS = new Set(["pc", "laptop", "server", "printer", "phone", "ipphone", "tablet", "smartphone",
          "iot", "host", "end_device"]);

export class LayoutResult {
    constructor(positions, canvas, scale, fits, size, shape, notes = []) {
        this.positions = positions;   // name → [x, y], top-left like PT
        this.canvas = canvas;
        this.scale = scale;
        this.fits = fits;             // False: the drawing is larger than the canvas
        this.size = size;             // width, height of the drawing (px)
        this.shape = shape;           // core shape: single, line, ring, star, circle
        this.notes = notes;
    }
}

function _natural(name) {
    /** Sort key that puts PC9 before PC10. */
    return name.split(/(\d+)/).map((t) => (/^\d+$/.test(t) ? parseInt(t, 10) : t.toLowerCase()));
}

// Compare two _natural keys the way Python compares the lists: element-wise,
// numbers numerically, strings by code point.
function _naturalCmp(a, b) {
    const ka = _natural(a), kb = _natural(b);
    const n = Math.min(ka.length, kb.length);
    for (let i = 0; i < n; i++) {
        const x = ka[i], y = kb[i];
        if (typeof x === "number" && typeof y === "number") {
            if (x !== y) return x - y;
        } else if (typeof x === "string" && typeof y === "string") {
            if (x < y) return -1;
            if (x > y) return 1;
        } else {
            // Python would raise TypeError comparing int to str; names in one
            // topology share a pattern, so this branch is not expected to run.
            return typeof x === "number" ? -1 : 1;
        }
    }
    return ka.length - kb.length;
}

function _is_host(cat) {
    return _HOSTS.has(cat.toLowerCase());
}

function _core_shape(core, adj) {
    /** [shape, ordered core]. Shapes: single, line, ring, star, circle. */
    const k = core.length;
    const cset = new Set(core);
    const cdeg = {};
    for (const c of core) cdeg[c] = [...adj[c]].filter((n) => cset.has(n)).length;
    if (k === 1) {
        return ["single", core];
    }
    const edges = Math.floor(Object.values(cdeg).reduce((a, b) => a + b, 0) / 2);
    // Connected?
    const seen = new Set([core[0]]);
    const stack = [core[0]];
    while (stack.length) {
        const cur = stack.pop();
        for (const n of adj[cur]) {
            if (cset.has(n) && !seen.has(n)) {
                seen.add(n);
                stack.push(n);
            }
        }
    }
    const connected = seen.size === k;
    if (connected && edges === k - 1 && Math.max(...Object.values(cdeg)) <= 2) {
        const start = core.find((c) => cdeg[c] === 1) ?? core[0];
        const order = [start];
        let prev = null, cur = start;
        while (true) {
            const nxt = [...adj[cur]].filter((n) => cset.has(n) && n !== prev && !order.includes(n));
            if (!nxt.length) {
                break;
            }
            prev = cur; cur = nxt[0];
            order.push(cur);
        }
        // Keep the plan's natural order (R1 on the left) when the path allows it.
        if (core.indexOf(order[0]) > core.indexOf(order[order.length - 1])) {
            order.reverse();
        }
        return ["line", order];
    }
    if (connected && k >= 3 && edges === k && Object.values(cdeg).every((d) => d === 2)) {
        const start = core[0];
        const order = [start];
        let prev = null, cur = start;
        while (order.length < k) {
            const nxt = [...adj[cur]]
                .filter((n) => cset.has(n) && n !== prev && !order.includes(n))
                .sort((a, b) => core.indexOf(a) - core.indexOf(b));
            if (!nxt.length) {
                break;
            }
            prev = cur; cur = nxt[0];
            order.push(cur);
        }
        return ["ring", order];
    }
    // Python max(core, key=lambda c: (cdeg[c], -core.index(c))): first maximal wins.
    let hub = core[0];
    for (const c of core) {
        if (cdeg[c] > cdeg[hub]
            || (cdeg[c] === cdeg[hub] && -core.indexOf(c) > -core.indexOf(hub))) {
            hub = c;
        }
    }
    if (connected && k >= 3 && cdeg[hub] === k - 1 && edges === k - 1) {
        return ["star", [hub, ...core.filter((c) => c !== hub)]];
    }
    return ["circle", core];
}

function _place_core(shape, order, turn = 0.0) {
    /** [[positions, outward unit direction]] of the core devices, centred on (0, 0).
     *
     * `turn` (radians) rotates a ring, star or circle; a line and a single device ignore it.
     * Returns [pos, out] (Python tuple).
     */
    const pos = {};
    const out = {};
    const k = order.length;
    if (shape === "single") {
        pos[order[0]] = [0.0, 0.0];
        out[order[0]] = [0.0, 1.0];
        return [pos, out];
    }
    if (shape === "line") {
        order.forEach((c, i) => {
            pos[c] = [(i - (k - 1) / 2) * CORE_GAP, 0.0];
            if (i === 0) {
                out[c] = [-1.0, 0.0];
            } else if (i === k - 1) {
                out[c] = [1.0, 0.0];
            } else {
                out[c] = i % 2 === 1 ? [0.0, 1.0] : [0.0, -1.0];
            }
        });
        return [pos, out];
    }
    const ring_items = shape === "star" ? order.slice(1) : order;
    const n = ring_items.length;
    // Edge length CORE_GAP on a regular polygon; a star's spokes sit at that radius.
    const radius = shape === "star" ? CORE_GAP : CORE_GAP / (2 * Math.sin(Math.PI / n));
    ring_items.forEach((c, i) => {
        // Start at the top so a triangle stands on its base.
        let a = -Math.PI / 2 + 2 * Math.PI * i / n + turn;
        if (shape !== "star" && n % 2 === 0) {
            a += Math.PI / n;           // an even polygon sits flat
        }
        pos[c] = [radius * Math.cos(a), radius * Math.sin(a)];
        out[c] = [Math.cos(a), Math.sin(a)];
    });
    if (shape === "star") {
        const hub = order[0];
        pos[hub] = [0.0, 0.0];
        // The hub's own LANs go into the widest gap between its spokes.
        const angles = ring_items.map((c) => Math.atan2(out[c][1], out[c][0])).sort((a, b) => a - b);
        const gaps = angles.map((ang, i) => {
            const w0 = ((angles[(i + 1) % n] - ang) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
            return [w0 === 0 ? 2 * Math.PI : w0, ang];
        });
        // Python max(gaps): tuple compare, first maximal wins.
        let best = gaps[0];
        for (const g of gaps) {
            if (g[0] > best[0] || (g[0] === best[0] && g[1] > best[1])) best = g;
        }
        const [width, start] = best;
        const mid = start + width / 2;
        out[hub] = [Math.cos(mid), Math.sin(mid)];
    }
    return [pos, out];
}

class _Node {
    constructor(name, cat, children = []) {
        this.name = name;
        this.cat = cat;
        this.children = children;
    }
}

function _branch_tree(root, adj, cats, taken) {
    const node = new _Node(root, cats[root]);
    taken.add(root);
    const nbrs = [...adj[root]].sort((a, b) => {
        const ha = _is_host(cats[a]) ? 1 : 0, hb = _is_host(cats[b]) ? 1 : 0;
        if (ha !== hb) return ha - hb;
        return _naturalCmp(a, b);
    });
    for (const n of nbrs) {
        if (!taken.has(n)) {
            node.children.push(_branch_tree(n, adj, cats, taken));
        }
    }
    return node;
}

function _width(node) {
    /** Units across the branch direction (1 unit = one device side by side). */
    const leaves = node.children.filter((c) => !c.children.length);
    const inner = node.children.filter((c) => c.children.length);
    const leaf_w = leaves.length ? Math.min(leaves.length, ROW_MAX) : 0;
    return Math.max(1.0, leaf_w + inner.reduce((s, c) => s + _width(c), 0));
}

function _snap(d, step_deg) {
    /** `d` rounded to the nearest multiple of `step_deg` degrees. */
    const step = step_deg * Math.PI / 180;
    const a = pyRound(Math.atan2(d[1], d[0]) / step) * step;
    const x = Math.cos(a), y = Math.sin(a);
    return [Math.abs(x) < 1e-9 ? 0.0 : x, Math.abs(y) < 1e-9 ? 0.0 : y];
}

function _across(d) {
    /** Unit vector across an axis-aligned `d`, pointing right or down (reading order). */
    let v = [-d[1], d[0]];
    if (v[0] < 0 || (v[0] === 0 && v[1] < 0)) {
        v = [-v[0], -v[1]];
    }
    return v;
}

function _place_children(at, children, d, hop, pos) {
    /** Place `children` one `hop` beyond `at` along `d`, side by side across it.
     *
     * Devices with children of their own (a switch, an AP with clients) go in parallel,
     * each with the room its subtree needs; plain hosts follow, in rows of ROW_MAX. Rows
     * run along the screen axes even when `d` is diagonal, so a ring's LANs stay tidy.
     */
    if (!children.length) {
        return;
    }
    const axis = _snap(d, 90);
    const v = _across(axis);
    const unit = Math.abs(v[0]) * SPREAD_X + Math.abs(v[1]) * SPREAD_Y;
    const row_step = Math.abs(axis[0]) * SPREAD_X + Math.abs(axis[1]) * SPREAD_Y;
    const leaves = children.filter((c) => !c.children.length);
    const inner = children.filter((c) => c.children.length);
    const per_row = Math.min(leaves.length, ROW_MAX);
    const total = inner.reduce((s, c) => s + _width(c), 0) + per_row;
    let cursor = -total / 2;
    for (const c of inner) {
        const w = _width(c);
        const off = (cursor + w / 2) * unit;
        const p = [at[0] + d[0] * hop + v[0] * off, at[1] + d[1] * hop + v[1] * off];
        pos[c.name] = p;
        _place_children(p, c.children, axis, NEXT_HOP, pos);
        cursor += w;
    }
    for (let i = 0; i < leaves.length; i++) {
        const c = leaves[i];
        const row = Math.floor(i / per_row), col = i % per_row;
        const in_row = Math.min(per_row, leaves.length - row * per_row);
        const off = (cursor + (per_row - in_row) / 2 + col + 0.5) * unit;
        const depth = hop + row * row_step;
        pos[c.name] = [at[0] + d[0] * depth + v[0] * off, at[1] + d[1] * depth + v[1] * off];
    }
}

function _angle_gap(a, b) {
    const m = ((a - b + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    return Math.abs(m - Math.PI);
}

function _free_direction(pos, c, core_peers, out) {
    /** The compass direction (45° steps) for `c`'s LANs: as far as possible from its
     * links to other core devices, and among equals the closest to its outward one.
     *
     * In a row this is the outward side for the ends and up/down for the middle ones; on
     * a hub it is the widest gap between spokes, so the hub's LAN never sits on a spoke.
     */
    const used = [...core_peers].map((n) => Math.atan2(pos[n][1] - pos[c][1], pos[n][0] - pos[c][0]));
    const want = Math.atan2(out[1], out[0]);

    const score = (a) => {
        const free = used.length ? Math.min(...used.map((u) => _angle_gap(a, u))) : Math.PI;
        return [Number(pyRound(free, 3)), -_angle_gap(a, want)];
    };

    // Python max(_COMPASS, key=score): first maximal wins on ties.
    let best = _COMPASS[0], bestScore = score(best);
    for (const a of _COMPASS.slice(1)) {
        const s = score(a);
        if (s[0] > bestScore[0] || (s[0] === bestScore[0] && s[1] > bestScore[1])) {
            best = a; bestScore = s;
        }
    }
    return _snap([Math.cos(best), Math.sin(best)], 45);
}

function _draw(shape, order, turn, adj, cats) {
    /** Unscaled centres of the core and of everything hanging from it. */
    const [pos, out] = order.length ? _place_core(shape, order, turn) : [{}, {}];

    const taken = new Set(order);
    // Branches of each core device go along its outward direction, side by side.
    for (const c of order) {
        const corePeers = new Set([...adj[c]].filter((n) => order.includes(n)));
        const d = _free_direction(pos, c, corePeers, out[c]);
        const heads = [...adj[c]].filter((n) => !taken.has(n)).sort((a, b) => {
            const ha = _is_host(cats[a]) ? 1 : 0, hb = _is_host(cats[b]) ? 1 : 0;
            if (ha !== hb) return ha - hb;
            return _naturalCmp(a, b);
        });
        const clouds = heads.filter((n) => cats[n] === "cloud");
        const trees = [];
        for (const h of heads) {
            if (!taken.has(h) && cats[h] !== "cloud") {
                trees.push(_branch_tree(h, adj, cats, taken));
            }
        }
        _place_children(pos[c], trees, d, FIRST_HOP, pos);
        // A WAN cloud gets its own side, the one farthest from the core links and the
        // LANs (ties: up, where the Internet is usually drawn).
        const used = [...adj[c]].filter((n) => order.includes(n))
            .map((n) => Math.atan2(pos[n][1] - pos[c][1], pos[n][0] - pos[c][0]));
        if (trees.length) {
            used.push(Math.atan2(d[1], d[0]));
        }
        for (const cl of clouds) {
            if (taken.has(cl)) {
                continue;
            }
            // Python max(_COMPASS, key=...): first maximal wins on ties.
            let best = _COMPASS[0];
            const cloudScore = (a) => {
                const free = used.length
                    ? Math.min(...used.map((u) => Math.abs(((a - u + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI)))
                    : Math.PI;
                return [free, -Math.abs(a + Math.PI / 2)];
            };
            let bestScore = cloudScore(best);
            for (const a of _COMPASS.slice(1)) {
                const s = cloudScore(a);
                if (s[0] > bestScore[0] || (s[0] === bestScore[0] && s[1] > bestScore[1])) {
                    best = a; bestScore = s;
                }
            }
            pos[cl] = [pos[c][0] + Math.cos(best) * FIRST_HOP, pos[c][1] + Math.sin(best) * FIRST_HOP];
            used.push(best);
            const tree = _branch_tree(cl, adj, cats, taken);
            _place_children(pos[cl], tree.children, [Math.cos(best), Math.sin(best)], NEXT_HOP, pos);
        }
    }

    return pos;
}

function _fit_scale(pos, W, H) {
    /** [fit_x, fit_y]: how much each axis may grow to fill the canvas. */
    const xs = Object.values(pos).map((p) => p[0]);
    const ys = Object.values(pos).map((p) => p[1]);
    const span_x = Math.max(...xs) - Math.min(...xs);
    const span_y = Math.max(...ys) - Math.min(...ys);
    const avail_x = W - 2 * MARGIN - ICON_W;
    const avail_y = H - 2 * MARGIN - ICON_H - LABEL_H;
    return [span_x ? avail_x / span_x : SCALE_MAX, span_y ? avail_y / span_y : SCALE_MAX];
}

export function layout(devices, links, canvas = null, attach = null) {
    /** Positions for `devices` ([[name, category]]) joined by `links` ([[a, b]]).
     *
     * `attach` adds links that are not cables, e.g. a WiFi laptop → the AP of its LAN,
     * so it is drawn next to that AP. `canvas` is the visible (width, height); null uses
     * DEFAULT_CANVAS.
     */
    const [W, H] = (canvas !== null && canvas !== undefined) ? canvas : DEFAULT_CANVAS;
    const cats = {};
    for (const [n, c] of devices) cats[n] = (c || "").toLowerCase();
    const names = devices.map(([n]) => n);
    const adj = {};
    for (const n of names) adj[n] = new Set();
    const allLinks = [...links, ...Object.entries(attach ?? {})];
    for (const [a, b] of allLinks) {
        if (a in adj && b in adj && a !== b) {
            adj[a].add(b);
            adj[b].add(a);
        }
    }

    const notes = [];
    let core = names.filter((n) => cats[n] === "router");
    if (!core.length) {
        const candidates = names.filter((n) => !_is_host(cats[n]));
        const pool = candidates.length ? candidates : names;
        if (pool.length) {
            // Python max(pool, key=lambda n: (len(adj[n]), -names.index(n))).
            let best = pool[0];
            for (const n of pool) {
                if (adj[n].size > adj[best].size
                    || (adj[n].size === adj[best].size && -names.indexOf(n) > -names.indexOf(best))) {
                    best = n;
                }
            }
            core = [best];
        }
    }
    const [shape, order] = core.length ? _core_shape(core, adj) : ["single", []];
    // A ring, star or circle may turn: keep the turn that lets the drawing grow the most
    // in the canvas (a tall star on a wide screen lies on its side). The upright one
    // wins unless another is clearly better.
    let turns = [0.0];
    if (["ring", "star", "circle"].includes(shape)) {
        // Python range(15, 360, 15): 15, 30, ..., 345 (23 values).
        turns = turns.concat(Array.from({ length: 23 }, (_, i) => (15 + i * 15) * Math.PI / 180));
    }
    let best_pos = null, best_fit = -1.0;
    for (const t of turns) {
        const cand = _draw(shape, order, t, adj, cats);
        const [fx, fy] = pyTruthy(cand) ? _fit_scale(cand, W, H) : [1.0, 1.0];
        const score = Math.min(Math.min(fx, fy), 1.0) * (t === 0.0 ? 1.0 : 0.97);
        if (score > best_fit) {
            best_pos = cand; best_fit = score;
        }
    }
    const pos = pyTruthy(best_pos) ? best_pos : {};

    // Anything still unplaced (not connected to the core) goes on a row under the rest.
    const loose = names.filter((n) => !(n in pos));
    if (loose.length) {
        // Connected groups among the loose devices keep together.
        const ys = Object.values(pos).map((p) => p[1]);
        const xs = Object.values(pos).map((p) => p[0]);
        const base_y = (ys.length ? Math.max(...ys) : 0.0) + NEXT_HOP + 40;
        const x0 = ((xs.length ? Math.min(...xs) : 0.0) + (xs.length ? Math.max(...xs) : 0.0)) / 2
            - (loose.length - 1) * SPREAD_X / 2;
        loose.forEach((n, i) => {
            pos[n] = [x0 + i * SPREAD_X, base_y];
        });
        notes.push(`${loose.length} device(s) not connected to the core: placed in a row below ` +
                     `(${loose.slice(0, 6).join(", ")}${loose.length > 6 ? "…" : ""}).`);
    }

    if (!Object.keys(pos).length) {
        return new LayoutResult({}, [W, H], new PyFloat(1.0), true, [0, 0], shape, notes);
    }

    // Fit: scale the centres so the icons (plus labels) fill the canvas minus margins.
    const xs = Object.values(pos).map((p) => p[0]);
    const ys = Object.values(pos).map((p) => p[1]);
    const span_x = Math.max(...xs) - Math.min(...xs);
    const span_y = Math.max(...ys) - Math.min(...ys);
    const avail_x = W - 2 * MARGIN - ICON_W;
    const avail_y = H - 2 * MARGIN - ICON_H - LABEL_H;
    const fit_x = span_x ? avail_x / span_x : SCALE_MAX;
    const fit_y = span_y ? avail_y / span_y : SCALE_MAX;
    // Each axis scales on its own, so a tall shape (a star, a ring) can widen to a wide
    // canvas; the ratio is capped so the shape stays recognisable.
    let sx = Math.max(SCALE_MIN, Math.min(SCALE_MAX, fit_x));
    let sy = Math.max(SCALE_MIN, Math.min(SCALE_MAX, fit_y));
    sx = Math.min(sx, sy * MAX_STRETCH);
    sy = Math.min(sy, sx * MAX_STRETCH);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const draw_w = span_x * sx + ICON_W;
    const draw_h = span_y * sy + ICON_H + LABEL_H;
    const fits = draw_w <= W && draw_h <= H;
    // Centre in the canvas; an axis that does not fit starts at the margin instead, so
    // nothing goes negative (PT grows the canvas right and down, never left or up of 0).
    const ox = draw_w <= W ? W / 2 : MARGIN + span_x * sx / 2 + ICON_W / 2;
    const oy = draw_h <= H ? (H - LABEL_H) / 2 : MARGIN + span_y * sy / 2 + ICON_H / 2;
    const positions = {};
    for (const [n, p] of Object.entries(pos)) {
        positions[n] = [pyRound(ox + (p[0] - cx) * sx - ICON_W / 2),
                        pyRound(oy + (p[1] - cy) * sy - ICON_H / 2)];
    }
    if (!fits) {
        notes.push(`The topology needs about ${Math.trunc(draw_w)}x${Math.trunc(draw_h)} px and the canvas ` +
                     `shows ${W}x${H}: zoom out in PT (or maximise the window) to see all of it.`);
    }
    const scale = pyRound(Math.min(sx, sy), 3);
    return new LayoutResult(positions, [W, H], scale, fits,
                        [Math.trunc(draw_w), Math.trunc(draw_h)], shape, notes);
}
