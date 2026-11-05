// Device hardening validation.

import { PlanError, ErrorCode, ValidationResult } from "../models/errors.js";
import { pyTruthy } from "../../shared/pycompat.js";
import { has_control_chars } from "./text_rules.js";

function _check_no_newlines(value, field, device, errors) {
    /** A line break in a hardening field is an extra IOS command.
     *
     * The payload travels as a single string to configureIosDevice(), which splits it
     * on "\\n" and sends each piece to the device. A \\n in `hostname` or `secret` does not
     * break the JS: it becomes configuration nobody asked for.
     */
    if (has_control_chars(value)) {
        errors.push(new PlanError({
            code: ErrorCode.HARDENING_INVALID_CHARS,
            device: device,
            message: `The field '${field}' contains a line break.`,
            suggestion: (
                `Remove the line breaks from '${field}' — each one would become ` +
                "an extra IOS command on the device."
            ),
        }));
    }
}

export function validate_hardening(cfg) {
    const errors = [];
    const warnings = [];

    _check_no_newlines(cfg.hostname, "hostname", cfg.device, errors);
    _check_no_newlines(cfg.enable_secret, "enable_secret", cfg.device, errors);
    _check_no_newlines(cfg.banner_motd, "banner_motd", cfg.device, errors);
    for (const u of cfg.users) {
        _check_no_newlines(u.username, "users.username", cfg.device, errors);
        _check_no_newlines(u.secret, "users.secret", cfg.device, errors);
    }
    if (cfg.ssh) {
        _check_no_newlines(cfg.ssh.domain, "ssh.domain", cfg.device, errors);
    }

    // The generator delimits the banner with '#' (banner motd #text#). A '#' inside
    // the text closes the banner early, and IOS interprets whatever follows as configuration.
    // The invariant was documented in a comment in the generator, but nothing enforced it.
    if (cfg.banner_motd && cfg.banner_motd.includes("#")) {
        errors.push(new PlanError({
            code: ErrorCode.HARDENING_INVALID_CHARS,
            device: cfg.device,
            message: "The MOTD banner cannot contain '#'.",
            suggestion: (
                "'#' is the delimiter of the `banner motd` command; if it appears in the " +
                "text, IOS ends the banner there and runs the rest as commands. " +
                "Use another character."
            ),
        }));
    }

    if (cfg.ssh && cfg.ssh.enable) {
        if (!cfg.ssh.domain) {
            errors.push(new PlanError({
                code: ErrorCode.HARDENING_SSH_REQUIRES_DOMAIN,
                device: cfg.device,
                message: "SSH requires a domain-name (`ip domain-name`).",
                suggestion: "Define ssh.domain (e.g. 'lab.local').",
            }));
        }
        if (cfg.ssh.modulus < 768) {
            warnings.push(new PlanError({
                code: ErrorCode.HARDENING_WEAK_MODULUS,
                device: cfg.device,
                message: `RSA modulus ${cfg.ssh.modulus} is weak (<768).`,
                suggestion: "Use 1024 or 2048 for SSH v2.",
            }));
        }
        if (!pyTruthy(cfg.users)) {
            warnings.push(new PlanError({
                code: ErrorCode.VALIDATION_ERROR,
                device: cfg.device,
                message: "SSH enabled but there are no local users — you won't be able to log in.",
                suggestion: "Add at least one user in `users`.",
            }));
        }
    }

    if (cfg.console_login_local && pyTruthy(cfg.users)) {
        warnings.push(new PlanError({
            code: ErrorCode.HARDENING_CONSOLE_LOGIN,
            device: cfg.device,
            message: "The console will ask for Username/Password (`line console 0` / `login local`).",
            suggestion: (
                "From the next login on, pt_cli stops at Username:. Send the credentials as its " +
                "first commands, e.g. pt_cli(device, [\"<user>\", \"<secret>\", \"enable\", ...]); " +
                "the answer to Password: is masked in the reply."
            ),
        }));
    }

    return new ValidationResult({ errors: errors, warnings: warnings });
}

export function validate_hardening_against_topology(cfg, devices_in_pt) {
    const errors = [];
    if (!devices_in_pt.some((d) => d["name"] === cfg.device)) {
        errors.push(new PlanError({
            code: ErrorCode.HARDENING_DEVICE_NOT_FOUND,
            device: cfg.device,
            message: `Device '${cfg.device}' does not exist in the active topology.`,
            suggestion: "Call pt_query_topology to see the real names.",
        }));
    }
    return new ValidationResult({ errors: errors });
}
