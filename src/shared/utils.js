// Shared utilities. (Port of shared/utils.py)

import fs from "node:fs";
import path from "node:path";
import { PREFIX_TO_MASK } from "./constants.js";
import { pyJsonDumps, ipToInt, intToIp } from "./pycompat.js";

// Characters allowed in a path component. Everything else is replaced by "_",
// including separators (/ \), drive colons (C:) and NUL bytes.
const _UNSAFE_PATH_CHARS = /[^A-Za-z0-9._-]/g;

// Names reserved by Windows: creating "CON.txt" or "NUL" fails opaquely.
const _WINDOWS_RESERVED = new Set([
    "CON", "PRN", "AUX", "NUL",
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

const _MAX_COMPONENT_LEN = 100;

function _stripChars(s, chars) {
    let start = 0, end = s.length;
    while (start < end && chars.includes(s[start])) start++;
    while (end > start && chars.includes(s[end - 1])) end--;
    return s.slice(start, end);
}

export function safe_name_component(name, fallback = "topology") {
    /** Reduces a name to a safe path component (a single level, no escapes).
     *
     * Neutralizes separators, "..", drive letters and Windows reserved names.
     * Spaces are mapped to "_" — the historical behavior is kept so that the names of
     * projects already on disk do not change.
     */
    const cleaned0 = (name || "").trim().replace(_UNSAFE_PATH_CHARS, "_");
    let cleaned = cleaned0;
    // A component made only of dots ("." or "..") is an escape, not a name.
    if (!_stripChars(cleaned, "._-") || [...cleaned].every((c) => c === ".")) {
        return fallback;
    }
    if (_WINDOWS_RESERVED.has(cleaned.split(".")[0].toUpperCase())) {
        cleaned = `_${cleaned}`;
    }
    return cleaned.slice(0, _MAX_COMPONENT_LEN);
}

export function name_collisions(plan_names, live_names) {
    /** Plan device names that already exist on the canvas, in plan order. */
    const live = new Set(live_names);
    return plan_names.filter((n) => live.has(n));
}

export function classify_ping(stat_line) {
    /** Classifies a ping statistics line as "ok" | "partial" | "none".
     *
     * `interpret_ping` only says "at least one arrived", so 1 of 4 packets was reported
     * as CONNECTIVITY OK just like 4 of 4 — a dying link looked identical to a healthy
     * one. Partial loss is different information and deserves a different verdict.
     *
     * Covers the two formats Packet Tracer produces:
     *   - Host (PC/Server): "Packets: Sent = 4, Received = 4, Lost = 0 (0% loss)"
     *   - IOS (router/switch): "Success rate is 100 percent (4/5)"
     */
    if (!stat_line) {
        return "none";
    }

    const received = /Received\s*=\s*(\d+)/.exec(stat_line);
    if (received) {
        const got = parseInt(received[1], 10);
        const sent_m = /Sent\s*=\s*(\d+)/.exec(stat_line);
        let sent;
        if (sent_m) {
            sent = parseInt(sent_m[1], 10);
        } else {
            const lost_m = /Lost\s*=\s*(\d+)/.exec(stat_line);
            sent = got + (lost_m ? parseInt(lost_m[1], 10) : 0);
        }
        if (got <= 0) {
            return "none";
        }
        return got >= sent ? "ok" : "partial";
    }

    const rate = /Success rate is (\d+) percent/.exec(stat_line);
    if (rate) {
        const pct = parseInt(rate[1], 10);
        if (pct <= 0) {
            return "none";
        }
        return pct >= 100 ? "ok" : "partial";
    }

    const ratio = /\((\d+)\/(\d+)\)/.exec(stat_line);
    if (ratio) {
        const got = parseInt(ratio[1], 10), sent = parseInt(ratio[2], 10);
        if (got <= 0) {
            return "none";
        }
        return got >= sent ? "ok" : "partial";
    }

    return "none";
}

export function interpret_ping(stat_line) {
    /** True if a ping statistics line indicates at least one packet was received.
     *
     * Kept for backward compatibility with callers that already depended on the
     * boolean; the graded verdict lives in `classify_ping`.
     */
    return classify_ping(stat_line) !== "none";
}

export function resolve_within(base, ...parts) {
    /** Resolves `parts` under `base` and verifies that the result does not escape.
     *
     * Sanitizing the name is the first barrier; this check after resolve() is the one
     * that actually decides, because it covers symlinks and any case that
     * sanitization did not anticipate.
     */
    const base_resolved = path.resolve(base);
    const candidate = path.resolve(base_resolved, ...parts);
    const rel = path.relative(base_resolved, candidate);
    const inside = candidate === base_resolved || (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel));
    if (!inside) {
        throw new Error(
            `Path outside the base directory: ${candidate} is not inside ${base_resolved}`
        );
    }
    return candidate;
}

export function workdir_subdir(name, fallback) {
    /** A one-level folder under the MCP's working directory, never outside it.
     *
     * `server.main()` chdirs into `server.workdir()` (`PT_MCP_WORKDIR`), so the
     * current directory IS the working directory at run time. Every tool that takes
     * an `output_dir` goes through here: "../x", "C:/Windows" or "/etc" become a
     * harmless folder name inside it.
     */
    return resolve_within(process.cwd(), safe_name_component(name, fallback));
}

export function resolve_save_dir(directory) {
    /** The folder pt_save_project hands to PT ("" = PT's own save folder).
     *
     * An absolute path is the user's choice of where the lab lives (Documents, a
     * course folder), so it is allowed, but it must be an existing directory: nothing
     * is created outside the working directory. A relative path is a folder inside
     * the MCP's working directory (PT_MCP_WORKDIR), sanitised and created there.
     * Throws when the folder is unusable.
     */
    const raw = directory.trim();
    if (!raw) {
        return "";
    }
    let p = raw.startsWith("~") ? raw.replace(/^~(?=$|\/|\\)/, process.env.HOME || "~") : raw;
    if (path.isAbsolute(p)) {
        p = path.resolve(p);
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
            throw new Error(`directory does not exist: ${p}`);
        }
        return p;
    }
    const target = workdir_subdir(raw, "projects");
    fs.mkdirSync(target, { recursive: true });
    return target;
}

export function resolve_open_path(p) {
    /** The .pkt file pt_open_project opens, checked on this machine's disk first.
     *
     * Opening a lab the user already has is the point of the tool, so an absolute
     * path anywhere is allowed; it must end in .pkt and be an existing file. A
     * relative path is resolved inside the MCP's working directory and may not
     * leave it. Throws otherwise.
     */
    const raw = p.trim();
    if (!raw) {
        throw new Error("path is empty");
    }
    let candidate = raw.startsWith("~") ? raw.replace(/^~(?=$|\/|\\)/, process.env.HOME || "~") : raw;
    if (path.isAbsolute(candidate)) {
        candidate = path.resolve(candidate);
    } else {
        candidate = resolve_within(process.cwd(), raw);
    }
    if (path.extname(candidate).toLowerCase() !== ".pkt") {
        throw new Error("The file must end in .pkt");
    }
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        throw new Error(`file not found: ${candidate}`);
    }
    return candidate;
}

export function prefix_to_mask(prefix) {
    /** Converts a CIDR prefix to a dotted decimal mask. */
    if (Object.prototype.hasOwnProperty.call(PREFIX_TO_MASK, prefix)) {
        return PREFIX_TO_MASK[prefix];
    }
    const bits = ((0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF) >>> 0;
    return `${(bits >> 24) & 0xFF}.${(bits >> 16) & 0xFF}.${(bits >> 8) & 0xFF}.${bits & 0xFF}`;
}

export function wildcard_mask(network) {
    /** Computes the wildcard mask of a network.
     *
     * `network` is an object with a `netmask` dotted string (the pieces of
     * Python's IPv4Network this code uses), or a plain netmask string.
     */
    const maskStr = typeof network === "string" ? network : network.netmask;
    const wildcardInt = (ipToInt(maskStr) ^ 0xFFFFFFFF) >>> 0;
    return intToIp(wildcardInt);
}

export function first_ip(interfaces) {
    /** Returns the first IP from an interfaces dict. */
    for (const ip_cidr of Object.values(interfaces)) {
        return ip_cidr.split("/")[0];
    }
    return "0.0.0.0";
}

export function to_json(obj) {
    /** Compact JSON for tool replies: every later turn re-sends them, so no indentation. */
    return pyJsonDumps(obj, { ensureAscii: false, separators: [",", ":"] });
}

export function reply_json(obj) {
    /** A tool reply as compact JSON, minus the generated JS once it has been sent.
     *
     * The JS only helps before sending (dry_run, or bridge down so it can be pasted
     * by hand); after a send it is kilobytes of noise in the conversation.
     */
    if (
        obj !== null && typeof obj === "object" && !Array.isArray(obj)
        && obj["sent"] === true
        && !obj["dry_run"]
        && "js_payload" in obj
    ) {
        obj = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "js_payload"));
    }
    return to_json(obj);
}

// A plan for a large network (tens of sites) is too big to pass as a tool argument;
// the agent writes it to disk and hands over the path. 5 MB is far above any real plan.
const _MAX_PLAN_BYTES = 5 * 1024 * 1024;

export function read_plan_source(plan_json, plan_path) {
    /** The plan's JSON text, from `plan_json` or from the `.json` file at `plan_path`. */
    if (plan_path) {
        const p = plan_path.startsWith("~") ? plan_path.replace(/^~(?=$|\/|\\)/, process.env.HOME || "~") : plan_path;
        if (path.extname(p).toLowerCase() !== ".json") {
            throw new Error(`plan_path must point to a .json file, not '${path.basename(p)}'.`);
        }
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
            throw new Error(`plan_path not found: ${p}`);
        }
        if (fs.statSync(p).size > _MAX_PLAN_BYTES) {
            throw new Error(`${path.basename(p)} is larger than ${_MAX_PLAN_BYTES / (1024 * 1024)} MB.`);
        }
        return fs.readFileSync(p, "utf-8");
    }
    if (plan_json) {
        return plan_json;
    }
    throw new Error("Pass the plan as plan_json or plan_path (a .json file).");
}
