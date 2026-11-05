// Presentation mode: headless (default) or ui. (Port of shared/ui_mode.py)
//
// The device-panel tools (CLI, Command Prompt, IP Configuration...) do their work
// through the Script Engine API in both modes. The difference is whether the
// device's window is also opened in PT, on the matching tab/app, so the user can
// watch it and capture it.
//
// The mode is saved to disk (next to the bridge token) so it survives an MCP
// server restart: the user picks it once ("ui mode") and does not have to repeat
// it every session. Precedence:
//
//     show=True/False on the call  >  saved file  >  PT_MCP_UI_MODE  >  headless

import fs from "node:fs";
import path from "node:path";

export const HEADLESS = "headless";
export const UI = "ui";
export const VALID_MODES = [HEADLESS, UI];
export const ENV_VAR = "PT_MCP_UI_MODE";
const _FILE_NAME = "ui_mode.json";

// Synonyms people actually type ("show it", "visible", "gui").
const _ALIASES = {
    "headless": HEADLESS, "hidden": HEADLESS, "off": HEADLESS, "api": HEADLESS,
    "background": HEADLESS, "silent": HEADLESS, "false": HEADLESS, "0": HEADLESS,
    "ui": UI, "gui": UI, "on": UI, "visible": UI, "show": UI, "tabs": UI,
    "screen": UI, "true": UI, "1": UI,
};

export function normalize_mode(value) {
    /** Return 'headless' | 'ui', or null if `value` is not a recognisable mode. */
    if (value === null || value === undefined) {
        return null;
    }
    const v = String(value).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(_ALIASES, v) ? _ALIASES[v] : null;
}

async function _default_dir() {
    // Late import: bridge_token lives in infrastructure and shared should not
    // depend on infrastructure at import time.
    const { token_dir } = await import("../infrastructure/execution/bridge_token.js");
    return token_dir();
}

export class UiModeStore {
    /** Reads and persists the mode. `directory` is injectable for tests. */
    constructor(directory = null, environ = null) {
        this._dir = directory !== null && directory !== undefined ? String(directory) : null;
        this._env = environ === null || environ === undefined ? process.env : environ;
        this._resolvedDir = null;
    }

    async _dirPath() {
        if (this._dir) return this._dir;
        if (!this._resolvedDir) this._resolvedDir = await _default_dir();
        return this._resolvedDir;
    }

    async path() {
        return path.join(await this._dirPath(), _FILE_NAME);
    }

    _from_env() {
        return normalize_mode(this._env[ENV_VAR]) || HEADLESS;
    }

    async get() {
        try {
            const data = JSON.parse(fs.readFileSync(await this.path(), "utf-8"));
            return normalize_mode(data["mode"]) || this._from_env();
        } catch (e) {
            return this._from_env();
        }
    }

    async set(mode) {
        /** Save the mode. Throws if it is not valid. */
        const norm = normalize_mode(mode);
        if (norm === null) {
            throw new Error(
                `Invalid mode: '${mode}'. Use 'headless' or 'ui'.`
            );
        }
        const target = await this.path();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = target.replace(/(\.[^/.]+)$/, ".tmp");
        fs.writeFileSync(tmp, JSON.stringify({ "mode": norm }), "utf-8");
        fs.renameSync(tmp, target);
        return norm;
    }

    async should_show(show) {
        /** The call's explicit `show` wins; if it is null, the mode decides. */
        if (show !== null && show !== undefined) {
            return Boolean(show);
        }
        return (await this.get()) === UI;
    }
}
