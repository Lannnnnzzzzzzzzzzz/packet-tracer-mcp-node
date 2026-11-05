// Shared secret between the MCP server and the client inside Packet Tracer.
// (Port of infrastructure/execution/bridge_token.py)
//
// The HTTP bridge listens on loopback, but that does NOT protect it: a
// `POST /queue` with `Content-Type: text/plain` is a "simple" CORS request, so
// any web page open in the browser could queue JavaScript that PT runs with
// `new Function()`. Binding to 127.0.0.1 does not stop the request from being
// sent — it only prevents reading the response, and the injection never needed to read anything.
//
// What does close it is a secret that the attacker's web page cannot guess or
// derive. That is why the token is random and persisted, not derived from the time or
// from any public data: this repo is public and the attacker runs on the same
// machine, so any algorithm we can derive, they can derive too.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const _TOKEN_FILE = "bridge_token";
const _ENV_VAR = "PT_MCP_BRIDGE_TOKEN";
const _MIN_LEN = 32;
const _VALID = /^[A-Za-z0-9_-]+$/;

// Observable state for pt_bridge_status diagnostics: if the token had to be
// rotated, any already-paired client became stale and this must be reported.
let _rotated = false;
let _ephemeral = false;
let _cached = null;

export class BridgeTokenError extends Error {
    /** Could not obtain a usable token. */
}

export function token_dir() {
    /** Token directory, per user and local to the machine.
     *
     * On Windows it goes to %LOCALAPPDATA% and not %APPDATA%: the latter syncs in
     * roaming profiles, and a loopback secret has no reason to travel to a file
     * server. On POSIX, XDG_STATE_HOME is respected.
     */
    if (process.platform === "win32") {
        const base = process.env.LOCALAPPDATA || process.env.APPDATA;
        return base ? path.join(base, "packet-tracer-mcp") : path.join(os.homedir(), ".packet-tracer-mcp");
    }
    const xdg = process.env.XDG_STATE_HOME;
    if (xdg) {
        return path.join(xdg, "packet-tracer-mcp");
    }
    return path.join(os.homedir(), ".local", "state", "packet-tracer-mcp");
}

export function token_path() {
    return path.join(token_dir(), _TOKEN_FILE);
}

export function token_fingerprint(token) {
    /** Non-invertible fingerprint of the token, to identify the bridge without leaking it. */
    return crypto.createHash("sha256").update(token, "utf-8").digest("hex").slice(0, 16);
}

function _is_valid(token) {
    return token.length >= _MIN_LEN && _VALID.test(token);
}

function _read_existing(p) {
    /** Reads and validates the token on disk. null if it is not usable.
     *
     * BOM and whitespace are tolerated: the file is plain text and someone will
     * open it with Notepad sooner or later.
     */
    let raw;
    try {
        raw = fs.readFileSync(p, "utf-8");
    } catch (e) {
        return null;
    }
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    raw = raw.trim();
    return _is_valid(raw) ? raw : null;
}

function _token_urlsafe(nbytes) {
    // Python secrets.token_urlsafe(n): urlsafe base64 of n random bytes, no padding.
    return crypto.randomBytes(nbytes).toString("base64url");
}

function _write_new(p) {
    /** Creates the token with O_EXCL. null if another process won the race.
     *
     * O_EXCL and not "write temp + rename": rename is atomic but the last
     * writer wins, so two servers starting at the same time would end up with
     * DIFFERENT tokens. With O_EXCL the loser reads the winner's token.
     */
    const candidate = _token_urlsafe(32);
    let fd;
    try {
        fd = fs.openSync(p, "wx", 0o600);
    } catch (e) {
        if (e.code === "EEXIST") return null;
        throw e;
    }
    try {
        fs.writeSync(fd, candidate, null, "utf-8");
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    return candidate;
}

function _sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function get_bridge_token(refresh = false) {
    /** Returns the bridge token, creating it the first time.
     *
     * It never fails hard: if the file is corrupt it is rotated, and if the
     * directory cannot be written it falls back to a process-ephemeral token. A
     * server that does not start is worse than one that warns that re-pairing is needed.
     */
    const env = (process.env[_ENV_VAR] || "").trim();
    if (env) {
        // Explicit override: tests, CI and multi-client scenarios.
        // It goes through the SAME gate as the file (see the Python original:
        // a badly set variable is an explicit decision — starting anyway would
        // mean serving with the door open and telling no one). Fail hard.
        if (!_is_valid(env)) {
            throw new BridgeTokenError(
                `${_ENV_VAR} is not usable as a token: it needs at least ` +
                `${_MIN_LEN} characters from [A-Za-z0-9_-], and ${env.length} arrived. ` +
                "Fix it, or remove the variable so the server uses the " +
                "token on disk."
            );
        }
        return env;
    }

    if (_cached !== null && !refresh) {
        return _cached;
    }

    const p = token_path();
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    } catch (e) {
        _ephemeral = true;
        _cached = _token_urlsafe(32);
        return _cached;
    }

    for (let i = 0; i < 10; i++) {
        const existing = _read_existing(p);
        if (existing) {
            _cached = existing;
            return _cached;
        }

        if (fs.existsSync(p)) {
            // Exists but is not valid (empty, truncated, hand-edited).
            // Rotate and warn: any paired client has become stale.
            try {
                fs.unlinkSync(p);
                _rotated = true;
            } catch (e) {
                break;
            }
        }

        let created = null;
        try {
            created = _write_new(p);
        } catch (e) {
            break;
        }
        if (created) {
            _cached = created;
            return _cached;
        }
        // We lost the race: the winner already wrote, so we read again.
        _sleepSync(50);
    }

    _ephemeral = true;
    _cached = _token_urlsafe(32);
    return _cached;
}

export function token_was_rotated() {
    /** True if the token on disk was invalid and was regenerated at this startup. */
    return _rotated;
}

export function token_is_ephemeral() {
    /** True if it could not be persisted and the token dies with the process. */
    return _ephemeral;
}

export function reset_cache() {
    /** Clears the cached state. For tests only. */
    _cached = null;
    _rotated = false;
    _ephemeral = false;
}
