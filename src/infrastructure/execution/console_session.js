// Console engine: types commands into a device's console and reads the output.
// (Port of infrastructure/execution/console_session.py)
//
// It is what a person does in a router's CLI tab or in a PC's Desktop > Command
// Prompt, but through the Script Engine API (`TerminalLine.enterCommand` /
// `getOutput` / `getPrompt`). The GUI tab shows that same line (`con0`), so what
// is typed here shows up there.
//
// Behaviour verified against PT 9.0.1 (spike of 2026-10-07):
//
// - Most commands (`show`, `ipconfig`, configuration) leave their full output
//   within the same `enterCommand` call, with no waiting.
// - `ping`, `tracert`, `nslookup`... are asynchronous: the output arrives later
//   and `getPrompt()` does NOT change while they run. The only reliable signal is
//   seeing the prompt again at the END of the output.
// - A command IOS does not know is taken as a host to telnet to
//   ("Translating "xyz"...domain server") and the console hangs; anything typed
//   meanwhile IS LOST (not queued). So commands are typed one at a time, waiting
//   for the prompt; the hang is broken with Ctrl+Shift+6 (`enterChar(30,0)`).
// - While IOS asks a question, `getPrompt()` returns the question itself.
//
// Everything testable lives here at module level: the JS is built with
// `json.dumps` and the loop receives `send_and_wait` injected (tests pass a fake).

import { pyJsonDumps, pyRepr, pyRound, monotonic, sleep as _sleep_ms } from "../../shared/pycompat.js";

// Python time.sleep takes seconds; pycompat's sleep takes milliseconds.
const _default_sleep = (seconds) => _sleep_ms(seconds * 1000);

// Cap on the output per command sent from PT to the server. The bridge accepts
// 1 MiB per result; a large `show running-config` is around 10-20 KB.
export const OUTPUT_CAP = 60_000;

// One reportResult carries a whole batch, and the bridge answers 413 above
// MAX_BODY_BYTES (1 MiB) — after the batch's commands have already run. Sizes
// are UTF-8 bytes of the JSON as PT sends it (an upper bound is computed in
// the JS). A batch stops typing once BATCH_SOFT_BYTES are reported (the rest
// goes in the next batch); a single output that would push the reply past
// BATCH_HARD_BYTES is trimmed to its tail and flagged `trimmed`.
export const BATCH_SOFT_BYTES = 256 * 1024;
export const BATCH_HARD_BYTES = 768 * 1024;

// Most --More-- pages one command may turn before it is aborted. A large
// `show running-config` is a few dozen pages; this only stops a console that
// keeps paging forever (the per-command timeout stops it too).
export const MAX_MORE_PRESSES = 400;

// States of the tail of the output.
export const DONE = "done";
export const MORE = "more";
export const CONFIRM = "confirm";
export const QUESTION = "question";
export const TRANSLATING = "translating";
export const WAIT = "wait";

// Statuses of a finished command.
export const ST_OK = "ok";
export const ST_ERROR = "error";
export const ST_QUESTION = "question";
export const ST_TIMEOUT = "timeout";
export const ST_UNKNOWN = "unknown_command";

const _MORE_RE = /-+\s*More\s*-+\s*$/;
const _MORE_ANY_RE = / ?-+ ?More ?-+ ?/g;
const _TRANSLATING_RE = /Translating "[^"\n]*"\.\.\.domain server/;
// Questions with a safe default answer: Enter accepts them.
const _CONFIRM_RE = /(\[confirm\]|\[[^\]\n]*\]\?)\s*$/;
// Questions that need a deliberate answer: the next command answers them.
const _CONFIRM_PATTERN = "(\\[confirm\\]|\\[[^\\]\\n]*\\]\\?)\\s*$";
const _QUESTION_PATTERN = "(\\[yes/no\\]:?|\\[y/n\\]:?|\\(y/n\\)\\??|Password:|Username:|login:)\\s*$";
const _QUESTION_RE = new RegExp(_QUESTION_PATTERN, "i");
// While asking, PT makes the question the prompt (getPrompt() returns
// "Destination filename [startup-config]? "): such a prompt does not mean "the
// prompt came back". The JS uses the same pattern (syntax common to Python and JS).
const PROMPT_QUESTION_PATTERN = _CONFIRM_PATTERN + "|" + _QUESTION_PATTERN;
const PROMPT_QUESTION_RE = new RegExp(PROMPT_QUESTION_PATTERN, "i");
// An unsolicited IOS log line (`%LINK-5-CHANGED: ...`), optionally after a
// timestamp or sequence number. IOS prints them whenever they happen, so they
// can land after the "Press RETURN" banner or the initial dialog's question
// (seen live on PT 9.0.0: a 2960 with an active link). The prefix excludes `>`
// and `#`, so a prompt with a log glued to it is not taken for a log line.
const _LOG_LINE_PATTERN = "^[*.]?[\\w :.]*%[A-Z0-9_]+-\\d-[A-Z0-9_]+:";
const _LOG_LINE_RE = new RegExp(_LOG_LINE_PATTERN);
// An IOS prompt alone on its line: `Switch>`, `R1(config-if)#`.
const _PROMPT_LINE_PATTERN = "^[^\\s>#()]+(\\([^)\\n]*\\))?[>#]$";
const _PROMPT_LINE_RE = new RegExp(_PROMPT_LINE_PATTERN);
const _IOS_ERROR_RE = /^%\s*(Invalid input|Incomplete command|Ambiguous command|Unknown command|Unrecognized|Bad |Invalid |Error)/mi;
const _HOST_ERROR_RE = /^Invalid Command\.?\s*$/mi;

// Keys for `enterChar(ascii, 0)`.
export const KEY_SPACE = 32;
export const KEY_CTRL_C = 3;
export const KEY_CTRL_SHIFT_6 = 30;


// ---------------------------------------------------------------------------
// JS
// ---------------------------------------------------------------------------

function _resolve_line_js(dev) {
    /** Resolve `d` and `cl` (the console). `getCommandLine` works on routers and
     * hosts; `getCommandPrompt` is a fallback because it only exists on hosts. */
    return (
        `var d=ipc.network().getDevice(${dev});`
        + "if(!d){reportResult(JSON.stringify({ok:false,error:'device_not_found'}));return;}"
        + "var cl=null;try{cl=d.getCommandLine();}catch(e){}"
        + "if(!cl&&typeof d.getCommandPrompt==='function'){try{cl=d.getCommandPrompt();}catch(e){}}"
        + "if(!cl){reportResult(JSON.stringify({ok:false,error:'no_console'}));return;}"
    );
}


// `done`: the current prompt appears at the end of the output, AFTER the echo
// of the command (otherwise a command containing the prompt's text would count
// as finished before producing anything), and it is not a question.
const _SNAPSHOT_JS = (
    "var p=String(cl.getPrompt()||'');"
    + "var sl=out.slice(from);var st=sl.replace(/\\s+$/,'');var pt=p.replace(/\\s+$/,'');"
    + "var nl=st.indexOf('\\n');"
    + `var qre=new RegExp(${pyJsonDumps(PROMPT_QUESTION_PATTERN)},'i');`
    + "var done=pt.length>0&&nl>=0&&st.length-nl>=pt.length&&st.slice(-pt.length)===pt"
    + "&&!qre.test(pt);"
    // A host inside an SSH/telnet session: PT keeps getPrompt() at `C:\>` while the
    // screen shows the router's prompt, so take an IOS prompt line ending the output
    // as the prompt (otherwise every command there waited until its timeout).
    + "if(!done&&nl>=0&&typeof d.getCommandPrompt==='function'){"
    + "var ll=st.slice(st.lastIndexOf('\\n')+1);"
    + `if(new RegExp(${pyJsonDumps(_PROMPT_LINE_PATTERN)}).test(ll)&&!qre.test(ll)){p=ll;done=true;}}`
    + "var snap={from:from,len:out.length,out:sl.length>cap?sl.slice(-cap):sl,"
    + "cut:sl.length>cap,prompt:p,mode:String(cl.getMode()||''),done:done};"
);


// Upper bound of the UTF-8 bytes of `JSON.stringify(o)`: escapes are already
// ASCII in the string; a non-ASCII UTF-16 unit takes at most 3 bytes.
const _SIZE_JS = (
    "function __sz(o){var s=JSON.stringify(o);var m=s.match(/[^\\x00-\\x7f]/g);"
    + "return s.length+(m?2*m.length:0);}"
);


// `__core(o)`: the buffer without its trailing blank and async log lines, i.e.
// what the console last showed on its own. The banner / dialog checks look at
// this, not at the raw end of the buffer, which a %LINK line can follow.
const _CORE_JS = (
    `var __lre=new RegExp(${pyJsonDumps(_LOG_LINE_PATTERN)});`
    + "function __core(o){var end=o.length;while(end>0){var s=o.lastIndexOf('\\n',end-1);"
    + "var t=o.slice(s+1,end).replace(/^\\s+|\\s+$/g,'');"
    + "if(t!==''&&!__lre.test(t)){break;}end=s<0?0:s;}return o.slice(0,end);}"
);


// Priming, on the first batch only. A RETURN is sent when the console is
// waiting for one:
// - its core ends with the banner ("started!" at boot; "started." when
//   exec-timeout disconnected it, "con0 is now available"); or
// - on IOS, getPrompt() is '' (what PT 9.0.0 returns at the banner) and the
//   core does not end at a prompt, --More-- or a question: the banner may have
//   scrolled out of the buffer under the logs.
// Without it, the first command is spent as the RETURN (and reported as an
// empty `ok`). A console at a prompt, a pager or a question gets nothing.
const _PRIME_JS = (
    _CORE_JS
    + `var __pre=new RegExp(${pyJsonDumps(_PROMPT_LINE_PATTERN)});`
    + `var __mre=new RegExp(${pyJsonDumps(_MORE_RE.source)});`
    + `var __qre=new RegExp(${pyJsonDumps(PROMPT_QUESTION_PATTERN)},'i');`
    + "var o=String(cl.getOutput());var pr=String(cl.getPrompt()||'');var core=__core(o);"
    + "if(pr.indexOf('[yes/no]')>=0&&core.slice(-600).indexOf('initial configuration dialog')>=0)"
    + "{cl.enterCommand('no');primed.push('no');"
    + "o=String(cl.getOutput());pr=String(cl.getPrompt()||'');core=__core(o);}"
    + "var last=core.slice(core.lastIndexOf('\\n')+1).replace(/^\\s+|\\s+$/g,'');"
    + "if(/Press RETURN to get started[.!]?\\s*$/.test(core)"
    + "||(!host&&pr.replace(/\\s+/g,'')===''&&!__pre.test(last)&&!__mre.test(core)&&!__qre.test(core)))"
    + "{cl.enterCommand('');primed.push('');}"
);


export function build_run_js(device, commands, start, cap = OUTPUT_CAP) {
    /** Type `commands[start:]` one by one while each finishes immediately.
     *
     * Stops at the first one left pending (asynchronous, --More--, a question...)
     * and returns it with `done:false` for Python to handle. It also stops once
     * the reported output reaches BATCH_SOFT_BYTES, so the reply stays under the
     * bridge's body limit; Python types the rest in the next batch. On the first
     * batch (start == 0) it primes the console: answers `no` to a new router's
     * initial dialog and presses Enter on "Press RETURN to get started", even
     * when async log lines were printed after either (see `_PRIME_JS`).
     */
    const dev = pyJsonDumps(device);
    return (
        "(function(){"
        + `var cmds=${pyJsonDumps([...commands])};var start=${Math.trunc(start)};var cap=${Math.trunc(cap)};`
        + `var soft=${Math.trunc(BATCH_SOFT_BYTES)};var hard=${Math.trunc(BATCH_HARD_BYTES)};var used=256;`
        + _SIZE_JS
        + _resolve_line_js(dev)
        + "var host=(typeof d.getCommandPrompt==='function');"
        + "if(typeof d.isBooting==='function'&&d.isBooting()&&typeof d.skipBoot==='function'){d.skipBoot();}"
        + "var primed=[];"
        + "if(start===0){" + _PRIME_JS + "}"
        + "var res=[];"
        + "for(var i=start;i<cmds.length;i++){"
        + "var base=String(cl.getOutput()).length;"
        + "cl.enterCommand(cmds[i]);"
        + "var out=String(cl.getOutput());"
        // If PT trimmed the buffer, re-anchor on the command's echo.
        + "var from=out.length>=base?base:Math.max(0,out.lastIndexOf(cmds[i]));"
        + _SNAPSHOT_JS
        + "snap.i=i;var sz=__sz(snap);"
        // The command has already run, so its result must be reported: if its
        // output alone would overflow the reply, keep the tail (6 bytes per char
        // is the worst case, a JSON-escaped control character) and flag it.
        + "if(used+sz>hard){var room=hard-used-1024;var keep=room>0?Math.floor(room/6):0;"
        + "snap.out=keep>0?snap.out.slice(-keep):'';snap.cut=true;snap.trimmed=true;sz=__sz(snap);}"
        + "used+=sz;res.push(snap);if(!done||used>=soft){break;}"
        + "}"
        + "reportResult(JSON.stringify({ok:true,host:host,primed:primed,results:res}));"
        + "})();"
    );
}


const _ACTIONS_JS = {
    "": "",
    "space": `cl.enterChar(${KEY_SPACE},0);`,
    "enter": "cl.enterCommand('');",
    "abort_ios": `cl.enterChar(${KEY_CTRL_SHIFT_6},0);`,
    "abort_host": `cl.enterChar(${KEY_CTRL_C},0);`,
};


export function build_poll_js(device, from_index, command, action = "", cap = OUTPUT_CAP) {
    /** Optionally press a key, then return the output from `from_index` on. */
    if (!Object.prototype.hasOwnProperty.call(_ACTIONS_JS, action)) {
        throw new Error(`unknown action: ${pyRepr(action)}`);
    }
    const dev = pyJsonDumps(device);
    return (
        "(function(){"
        + `var cap=${Math.trunc(cap)};var cmd=${pyJsonDumps(command)};`
        + _resolve_line_js(dev)
        + _ACTIONS_JS[action]
        + "var out=String(cl.getOutput());"
        + `var from=${Math.trunc(from_index)};`
        + "if(out.length<from){var k=out.lastIndexOf(cmd);from=k>=0?k:0;}"
        + _SNAPSHOT_JS
        + "snap.ok=true;reportResult(JSON.stringify(snap));"
        + "})();"
    );
}


// ---------------------------------------------------------------------------
// Reading the output (pure Python, testable)
// ---------------------------------------------------------------------------

function _strip_more(text) {
    return text.replace(/\x08/g, "").replace(_MORE_ANY_RE, "");
}

export function is_done(out, prompt) {
    /** Same rule as the JS: prompt at the end, after the command's echo, and
     * the prompt is not a question. */
    const st = (out || "").trimEnd();
    const pt = (prompt || "").trimEnd();
    const nl = st.indexOf("\n");
    return (Boolean(pt) && nl >= 0 && st.length - nl >= pt.length && st.endsWith(pt)
        && !PROMPT_QUESTION_RE.test(pt));
}

export function classify_tail(out, prompt) {
    /** What the console is waiting for: DONE, MORE, CONFIRM, QUESTION, TRANSLATING or WAIT. */
    if (is_done(out, prompt)) {
        return DONE;
    }
    const raw = (out || "").replace(/\x08/g, "");
    const tail = raw.trimEnd();
    if (_MORE_RE.test(tail)) {
        return MORE;
    }
    if (_TRANSLATING_RE.test(raw.slice(-400))) {
        return TRANSLATING;
    }
    if (_CONFIRM_RE.test(tail)) {
        return CONFIRM;
    }
    if (_QUESTION_RE.test(tail)) {
        return QUESTION;
    }
    return WAIT;
}

export function clean_output(command, out, prompt) {
    /** Remove the command's echo, the final prompt and leftover --More-- markers. */
    let text = _strip_more(out || "");
    if (command && text.startsWith(command)) {
        text = text.slice(command.length);
    }
    text = text.trimEnd();
    const pt = (prompt || "").trimEnd();
    if (pt && text.endsWith(pt)) {
        text = text.slice(0, text.length - pt.length);
    }
    return text.replace(/^\n+/, "").replace(/\n+$/, "").trimEnd();
}

export function output_status(output, host) {
    if (_IOS_ERROR_RE.test(output || "") || (host && _HOST_ERROR_RE.test(output || ""))) {
        return ST_ERROR;
    }
    return ST_OK;
}


// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export class CommandResult {
    constructor({ command, status, output, prompt = "", mode = "", note = "" } = {}) {
        this.command = command;
        this.status = status;
        this.output = output;
        this.prompt = prompt;
        this.mode = mode;
        this.note = note;
    }

    to_dict() {
        return {
            "command": this.command,
            "status": this.status,
            "output": this.output,
            "prompt": this.prompt,
            "mode": this.mode,
            "note": this.note,
        };
    }
}

export class ConsoleRun {
    constructor({ device, ok, results = [], primed = [], host = null, error = "" } = {}) {
        this.device = device;
        this.ok = ok;
        this.results = results;
        this.primed = primed;
        this.host = host;
        this.error = error;
    }

    get final_prompt() {
        return this.results.length ? this.results[this.results.length - 1].prompt : "";
    }

    get final_mode() {
        return this.results.length ? this.results[this.results.length - 1].mode : "";
    }

    to_dict() {
        const d = {
            "device": this.device,
            "ok": this.ok,
            "results": this.results.map((r) => r.to_dict()),
            "primed": [...this.primed],
            "host": this.host,
            "error": this.error,
        };
        d["final_prompt"] = this.final_prompt;
        d["final_mode"] = this.final_mode;
        return d;
    }
}

const _ERRORS = {
    "device_not_found": "the device does not exist in the active topology",
    "no_console": "the device has no console (an unmanaged switch, a cable, a cloud?)",
};


function _parse(raw) {
    if (raw === null || raw === undefined) {
        return null;
    }
    if (raw.startsWith("PT_ERROR") || raw.startsWith("ERROR")) {
        return { "ok": false, "error": raw };
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return { "ok": false, "error": `unreadable reply from PT: ${raw.slice(0, 200)}` };
    }
    return (data !== null && typeof data === "object" && !Array.isArray(data))
        ? data : { "ok": false, "error": "unexpected reply" };
}


function _finish(command, snap, host, { status = null, note = "" } = {}) {
    const prompt = snap["prompt"] ?? "";
    const output = clean_output(command, snap["out"] ?? "", prompt);
    if (snap["trimmed"]) {
        note = ((note ? note + " " : "")
            + "(output trimmed to its tail to fit the bridge's 1 MiB reply limit)");
    } else if (snap["cut"]) {
        note = (note ? note + " " : "") + `(output cut to the last ${OUTPUT_CAP} characters)`;
    }
    return new CommandResult({
        command: command,
        status: status || output_status(output, host),
        output: output,
        prompt: prompt,
        mode: snap["mode"] ?? "",
        note: note,
    });
}


export async function run_commands(
    send_and_wait,
    device,
    commands,
    {
        timeout = 30.0,
        auto_confirm = true,
        poll_interval = 0.5,
        call_timeout = 15.0,
        clock = monotonic,
        sleep = _default_sleep,
    } = {},
) {
    /** Type `commands` into `device`'s console, in order, and return the output.
     *
     * - `timeout`: maximum wait PER command before aborting it (Ctrl+C on hosts,
     *   Ctrl+Shift+6 on IOS).
     * - `auto_confirm`: press Enter on questions with a default value
     *   (`[confirm]`, `Destination filename [startup-config]?`). `[yes/no]` and
     *   `Password:` questions are NOT answered automatically: the next command in
     *   the list is the answer.
     */
    const run = new ConsoleRun({ device: device, ok: true });
    let i = 0;
    while (i < commands.length) {
        const data = _parse(await send_and_wait(build_run_js(device, commands, i), call_timeout));
        if (data === null) {
            // The JS may have run anyway (a lost or rejected reply looks the
            // same as no reply): say so, a blind retry types the commands again.
            run.ok = false;
            run.error = (
                `No answer from PT (bridge timeout). Commands from #${i + 1} `
                + `(${pyRepr(commands[i])}) on may already have run on ${device}: check its `
                + "state (e.g. show running-config) before retrying, since a retry "
                + "types them again."
            );
            return run;
        }
        if (!data["ok"]) {
            run.ok = false;
            const err = String(data["error"] ?? "unknown error");
            run.error = Object.prototype.hasOwnProperty.call(_ERRORS, err) ? _ERRORS[err] : err;
            return run;
        }
        run.host = data["host"] !== undefined ? data["host"] : null;
        run.primed.push(...(data["primed"] || []));
        const batch = data["results"] || [];
        if (!batch.length) {
            run.ok = false;
            run.error = "PT returned no results for the batch.";
            return run;
        }
        for (const snap of batch) {
            const idx = Math.trunc(snap["i"] ?? i);
            const cmd = commands[idx];
            if (snap["done"]) {
                run.results.push(_finish(cmd, snap, run.host));
            } else {
                const result = await _drive_pending(
                    send_and_wait, device, cmd, snap, run.host,
                    {
                        timeout: timeout, auto_confirm: auto_confirm,
                        poll_interval: poll_interval, call_timeout: call_timeout,
                        clock: clock, sleep: sleep,
                    },
                );
                run.results.push(result);
            }
            i = idx + 1;
        }
    }
    return run;
}


async function _drive_pending(
    send_and_wait,
    device,
    command,
    snap,
    host,
    {
        timeout,
        auto_confirm,
        poll_interval,
        call_timeout,
        clock,
        sleep,
    },
) {
    /** Drive a pending command until the prompt returns, it asks something, or it times out. */
    let deadline = clock() + timeout;
    let from_index = Math.trunc(snap["from"] ?? 0);
    let confirms = 0;
    let more_presses = 0;
    let lookup_aborted = false;
    let timed_out = false;
    let abort_note = `aborted after ${pyRound(timeout)}s without the prompt coming back`;
    let cur = snap;

    while (true) {
        const state = classify_tail(cur["out"] ?? "", cur["prompt"] ?? "");
        if (state === DONE) {
            if (timed_out) {
                return _finish(command, cur, host, { status: ST_TIMEOUT, note: abort_note });
            }
            if (lookup_aborted) {
                return _finish(command, cur, host, {
                    status: ST_UNKNOWN,
                    note: "IOS did not recognise the command and took it as a "
                        + "hostname; the DNS lookup was aborted",
                });
            }
            return _finish(command, cur, host);
        }

        if (state === QUESTION || (state === CONFIRM && !(auto_confirm && confirms < 5))) {
            return _finish(command, cur, host, {
                status: ST_QUESTION,
                note: "the console is waiting for an answer; send it as the "
                    + "next command",
            });
        }

        // The deadline (and the --More-- cap) is checked on EVERY iteration:
        // a key press is not progress, and a console stuck on --More-- used
        // to skip this check and loop forever.
        const out_of_time = clock() >= deadline;
        const too_many_pages = state === MORE && more_presses >= MAX_MORE_PRESSES;
        let action = "";
        if (out_of_time || too_many_pages) {
            if (timed_out) {
                // Already aborted once and the prompt did not come back: stop.
                return _finish(command, cur, host, {
                    status: ST_TIMEOUT,
                    note: abort_note + "; the console did not respond to the abort",
                });
            }
            timed_out = true;
            if (too_many_pages && !out_of_time) {
                abort_note = (`aborted after ${more_presses} --More-- pages without `
                    + "the prompt coming back");
            }
            deadline = clock() + 5.0;
            more_presses = MAX_MORE_PRESSES; // no more paging during the grace period
            action = host ? "abort_host" : "abort_ios";
        } else if (state === MORE) {
            action = "space";
            more_presses += 1;
        } else if (state === TRANSLATING && !lookup_aborted) {
            action = "abort_ios";
            lookup_aborted = true;
        } else if (state === CONFIRM) {
            action = "enter";
            confirms += 1;
        } else {
            await sleep(poll_interval);
        }

        const data = _parse(await send_and_wait(
            build_poll_js(device, from_index, command, action), call_timeout
        ));
        if (data === null || !data["ok"]) {
            if (clock() >= deadline) {
                return _finish(command, cur, host, {
                    status: ST_TIMEOUT,
                    note: "no answer from PT while polling the console",
                });
            }
            continue;
        }
        from_index = Math.trunc(data["from"] ?? from_index);
        cur = data;
    }
}


// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const _STATUS_MARK = {
    [ST_OK]: "ok", [ST_ERROR]: "ERROR", [ST_QUESTION]: "WAITING FOR ANSWER",
    [ST_TIMEOUT]: "TIMEOUT", [ST_UNKNOWN]: "UNKNOWN COMMAND",
};


export function format_run(run, label) {
    /** Readable transcript, as it would look on the console, with each command's status. */
    if (!run.ok && !run.results.length) {
        return `${run.device}: could not use the console — ${run.error}`;
    }
    const counts = new Map();
    for (const r of run.results) {
        counts.set(r.status, (counts.get(r.status) || 0) + 1);
    }
    const summary = [...counts.entries()]
        .map(([s, n]) => `${n} ${_STATUS_MARK[s] ?? s}`).join(", ");
    const lines = [`${run.device} (${label}) — ${run.results.length} command(s): ${summary}`];
    if (run.primed.length) {
        lines.push("(console primed: answered the initial dialog / Press RETURN)");
    }
    let prev_prompt = "";
    for (const r of run.results) {
        const mark = _STATUS_MARK[r.status] ?? r.status;
        lines.push("");
        // What answers a Password: prompt is a secret: never echo it back.
        const shown = prev_prompt.trimEnd().toLowerCase().endsWith("password:") ? "********" : r.command;
        lines.push(prev_prompt ? `${prev_prompt}${shown}    [${mark}]` : `> ${shown}    [${mark}]`);
        if (r.output) {
            lines.push(r.output);
        }
        if (r.note) {
            lines.push(`  ↳ ${r.note}`);
        }
        prev_prompt = r.prompt;
    }
    if (!run.ok) {
        lines.push("");
        lines.push(`Interrupted: ${run.error}`);
    }
    lines.push("");
    lines.push(`Final prompt: ${run.final_prompt || "?"}  (mode: ${run.final_mode || "?"})`);
    return lines.join("\n");
}
