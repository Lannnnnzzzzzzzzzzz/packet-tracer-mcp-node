// Validation of the commands typed into a PT console.
//
// Each command travels as ONE line to `TerminalLine.enterCommand()`. A newline
// inside a command does not break the JS (it goes through `json.dumps`), but PT
// would type it as two commands: the second would be something nobody asked for.
// So it is rejected here instead of being silently split; whoever wants several
// lines sends several commands.

import { ErrorCode, PlanError, ValidationResult } from "../models/errors.js";
import { pyRepr, pyFloatRepr, pyTruthy } from "../../shared/pycompat.js";
import { has_control_chars } from "./text_rules.js";

export const MAX_COMMANDS = 200;
export const MAX_COMMAND_LEN = 1024;
// Per-command wait. A tracert through unreachable hops is the slowest thing a
// console does; beyond this a call would just hold the MCP request open.
export const MAX_CONSOLE_TIMEOUT_S = 300.0;

// Other control characters mean something else on a real console (Ctrl+C,
// Ctrl+Z, ESC...). Tab is allowed: IOS uses it for completion.
const _FORBIDDEN_CONTROL = new Set(
    Array.from({ length: 0x20 }, (_, c) => String.fromCharCode(c)).filter((ch) => ch !== "\t")
);

export function split_commands(commands) {
    /** Accept a list or a block of text and return one line per command.
     *
     * A block ("enable\\nconf t\\n...") is what a model naturally writes to
     * configure a router, so it is accepted and split into lines. A list is kept
     * as is: there, a newline inside an item is an error.
     */
    if (commands === null || commands === undefined) {
        return [];
    }
    if (typeof commands === "string") {
        return commands.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    }
    return commands.map((c) => String(c));
}

export function validate_console_commands(device, commands, timeout = null) {
    /** Commands for one console call; `timeout` (per command) is checked when given. */
    const errors = [];

    if (timeout !== null && timeout !== undefined && !(
        (typeof timeout === "number") && Number.isFinite(timeout)
        && 0 < timeout && timeout <= MAX_CONSOLE_TIMEOUT_S
    )) {
        errors.push(new PlanError({
            code: ErrorCode.CONSOLE_INVALID_TIMEOUT,
            device: device,
            message: `timeout=${typeof timeout === "number" ? pyFloatRepr(timeout) : pyRepr(timeout)} is out of range (more than 0, up to ` +
                    `${MAX_CONSOLE_TIMEOUT_S.toFixed(0)} seconds per command).`,
            suggestion: "A failing ping takes ~15 s; 30-60 s covers almost everything.",
        }));
    }

    if (!(device || "").trim()) {
        errors.push(new PlanError({
            code: ErrorCode.CONSOLE_DEVICE_REQUIRED,
            message: "The device name is missing.",
            suggestion: "Use pt_query_topology to see the exact names.",
        }));
    }

    if (!pyTruthy(commands)) {
        errors.push(new PlanError({
            code: ErrorCode.CONSOLE_EMPTY,
            device: device,
            message: "There are no commands to run.",
            suggestion: "Pass at least one command, for example 'show ip interface brief'.",
        }));
    } else if (commands.length > MAX_COMMANDS) {
        errors.push(new PlanError({
            code: ErrorCode.CONSOLE_TOO_MANY_COMMANDS,
            device: device,
            message: `${commands.length} commands in one call (maximum ${MAX_COMMANDS}).`,
            suggestion: "Split them across several calls.",
        }));
    }

    commands.forEach((cmd, i) => {
        if (has_control_chars(cmd) || [...cmd].some((ch) => _FORBIDDEN_CONTROL.has(ch))) {
            errors.push(new PlanError({
                code: ErrorCode.CONSOLE_INVALID_CHARS,
                device: device,
                message: `Command #${i + 1} contains a newline or a control character.`,
                suggestion: "One command per item; newlines would be typed as extra commands.",
            }));
        }
        if (cmd.length > MAX_COMMAND_LEN) {
            errors.push(new PlanError({
                code: ErrorCode.CONSOLE_COMMAND_TOO_LONG,
                device: device,
                message: `Command #${i + 1} is ${cmd.length} characters long (maximum ${MAX_COMMAND_LEN}).`,
                suggestion: "Shorten it; no IOS or Command Prompt line needs that much.",
            }));
        }
    });

    return new ValidationResult({ errors: errors });
}
