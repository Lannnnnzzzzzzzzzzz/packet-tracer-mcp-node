// `pt-mcp install-skill`: copies the companion Agent Skill to where the agent reads it.
// (Port of skill_install.py)
//
// Without the skill the MCP works halfway: the model guesses model names, ports and
// Script-Engine methods instead of discovering them. Until now the only way to install it
// was `cp -r skill/.` from a clone, so whoever installed with pip or uvx had no way to get
// it. The skill now travels inside the wheel (`packet_tracer_mcp/_skill`, see
// pyproject.toml) and this command puts it in place.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SKILL_NAME = "packet-tracer";

export function skill_source() {
    /** The skill shipped in the wheel or, running from a clone, the repo's `skill/`. */
    const bundled = path.resolve(__dirname, "_skill");
    if (fs.existsSync(path.join(bundled, "SKILL.md")) && fs.statSync(path.join(bundled, "SKILL.md")).isFile()) {
        return bundled;
    }
    const repo = path.resolve(__dirname, "..", "skill");
    if (fs.existsSync(path.join(repo, "SKILL.md")) && fs.statSync(path.join(repo, "SKILL.md")).isFile()) {
        return repo;
    }
    const err = new Error("the packet-tracer skill is not in this install (no _skill/ and no repo skill/)");
    err.code = "ENOENT";
    throw err;
}

export function default_dest() {
    // Claude Code's user-level skills folder; OpenCode also reads ~/.claude/skills.
    return path.join(os.homedir(), ".claude", "skills");
}

function _is_link(p) {
    // A Windows directory junction (`mklink /J`, no admin needed) is not a symlink to
    // is_symlink(), and shutil.rmtree refuses it.
    // JS port: Node's lstat does not expose the Windows reparse tag, so junctions
    // cannot be told apart from real directories here; symlinks are detected.
    let st;
    try {
        st = fs.lstatSync(p);
    } catch (e) {
        return false;
    }
    return st.isSymbolicLink();
}

// Path.expanduser()
function _expanduser(p) {
    if (p === "~") {
        return os.homedir();
    }
    if (p.startsWith("~/") || p.startsWith("~\\")) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}

export function install(dest_root) {
    const src = skill_source();
    const dest = path.join(_expanduser(String(dest_root)), SKILL_NAME);
    if (_is_link(dest)) {
        // A link to a skill kept elsewhere (a dotfiles or skills repo): drop the link, never
        // what it points to, which is not ours to delete.
        let target = "";
        try {
            target = fs.readlinkSync(dest);
        } catch (e) {
            // A junction: readlink is unavailable; the name alone is reported.
        }
        console.log(`replacing the link ${dest} -> ${target} with a copy (the linked folder is untouched)`);
        if (fs.lstatSync(dest).isSymbolicLink()) {
            fs.unlinkSync(dest);
        } else {
            fs.rmdirSync(dest); // removes the junction itself, not its target
        }
    } else if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.cpSync(src, dest, { recursive: true });
    return dest;
}

const _USAGE = "usage: pt-mcp install-skill [-h] [--dest DEST]";

export async function main(args) {
    // argparse.ArgumentParser(prog="pt-mcp install-skill", description=...)
    let dest = default_dest();
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-h" || a === "--help") {
            console.log(_USAGE);
            console.log("");
            console.log("Install the packet-tracer Agent Skill so the AI drives the MCP from verified facts.");
            console.log("");
            console.log("options:");
            console.log("  -h, --help  show this help message and exit");
            console.log("  --dest DEST skills folder of your agent (default: ~/.claude/skills). The skill goes to <dest>/packet-tracer.");
            return 0;
        } else if (a === "--dest") {
            if (i + 1 >= args.length) {
                console.error(`${_USAGE}\npt-mcp install-skill: error: argument --dest: expected one argument`);
                return 2;
            }
            dest = args[++i];
        } else if (a.startsWith("--dest=")) {
            dest = a.slice("--dest=".length);
        } else {
            console.error(`${_USAGE}\npt-mcp install-skill: error: unrecognized arguments: ${a}`);
            return 2;
        }
    }
    let installed;
    try {
        installed = install(dest);
    } catch (e) {
        console.error(`could not install the skill: ${e.message}`);
        return 1;
    }
    console.log(`skill installed: ${installed}`);
    console.log("Restart your agent (or run /reload-skills in Claude Code) so it picks it up.");
    return 0;
}
