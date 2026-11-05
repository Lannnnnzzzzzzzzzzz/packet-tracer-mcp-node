// Security posture audit of PT's live topology.
//
// Pure logic, no bridge — testable with synthetic dicts, like topology_diff.
//
// DESIGN NOTE — this module never receives or returns credentials. The bridge
// reader classifies each credential by its prefix and sends ONLY the algorithm
// label ("md5", "type7", ...). A hash in a tool's output ends up in the LLM's
// context and in the MCP client's logs; the label is enough to audit,
// and there is no reason to take that risk.
//
// Algorithm classification (verified against PT 9.0.0.0810):
//   $1$...  -> "md5"      `enable secret` / `username X secret` (type 5)
//   $8$...  -> "pbkdf2"   type 8
//   $9$...  -> "scrypt"   type 9
//   hex     -> "type7"    `password` with service-password-encryption — REVERSIBLE
//   other   -> "plaintext"

import { pyStr, pyTruthy } from "../../shared/pycompat.js";

// Algorithms an attacker can reverse to the original password: type 7 is
// a Vigenère cipher with a published key (online decoders exist), and
// plaintext does not even try.
export const REVERSIBLE_ALGOS = new Set(["type7", "plaintext"]);

// MD5 without a per-device salt is crackable offline with modern hardware. It is not
// reversible, so it is one step less severe than type 7, but Cisco has recommended
// type 8/9 for years.
export const WEAK_HASH_ALGOS = new Set(["md5"]);

// 0x2102 (8450) is the normal value. 0x2142 (8514) skips the startup-config at
// boot: it is the password-recovery procedure, and leaving it set
// means a reboot discards the entire security configuration.
export const CONFIG_REGISTER_NORMAL = 0x2102;
export const CONFIG_REGISTER_BYPASS = 0x2142;

// Python dict .get(key, default): default only when the key is absent.
function _getd(obj, key, def) {
    return (obj !== null && obj !== undefined && obj[key] !== undefined) ? obj[key] : def;
}

function _finding(device, code, severity, message, suggestion) {
    return {
        "device": device,
        "code": code,
        "severity": severity,
        "message": message,
        "suggestion": suggestion,
    };
}

function _audit_device(dev) {
    const name = _getd(dev, "name", "?");
    const findings = [];

    // --- Privileged mode access ---
    if (!pyTruthy(dev.enable_secret_set)) {
        findings.push(_finding(
            name, "NO_ENABLE_SECRET", "high",
            "No `enable secret`: anyone with console access gets privileged mode.",
            "Set `enable secret <key>` (or use pt_apply_hardening with enable_secret).",
        ));
    } else {
        const algo = dev.enable_secret_algo !== undefined ? dev.enable_secret_algo : null;
        if (REVERSIBLE_ALGOS.has(algo)) {
            findings.push(_finding(
                name, "ENABLE_SECRET_REVERSIBLE", "high",
                `The \`enable secret\` is stored with a reversible algorithm (${pyStr(algo)}).`,
                "Reconfigure it with `enable secret` (hash) instead of `enable password`.",
            ));
        } else if (WEAK_HASH_ALGOS.has(algo)) {
            findings.push(_finding(
                name, "ENABLE_SECRET_WEAK_ALGO", "medium",
                "The `enable secret` uses MD5 (type 5), crackable offline.",
                "If the IOS supports it, use `enable algorithm-type scrypt secret <key>`.",
            ));
        }
    }

    // `enable password` and `enable secret` can coexist; the password is
    // reversible and stays in the config even though the secret is the one that takes effect.
    if (pyTruthy(dev.enable_password_set)) {
        findings.push(_finding(
            name, "ENABLE_PASSWORD_PRESENT", "medium",
            "An `enable password` is configured, and it is stored reversibly.",
            "Remove it with `no enable password` and keep only `enable secret`.",
        ));
    }

    // --- Local credentials ---
    const users = pyTruthy(dev.users) ? dev.users : [];
    for (const user of users) {
        const uname = _getd(user, "name", "?");
        const ualgo = user.algo !== undefined ? user.algo : null;
        if (REVERSIBLE_ALGOS.has(ualgo)) {
            findings.push(_finding(
                name, "USER_CREDENTIAL_REVERSIBLE", "high",
                `Local user '${pyStr(uname)}' stores its credential reversibly (${pyStr(ualgo)}).`,
                `Recreate it with \`username ${pyStr(uname)} secret <key>\` instead of \`password\`.`,
            ));
        } else if (WEAK_HASH_ALGOS.has(ualgo)) {
            findings.push(_finding(
                name, "USER_CREDENTIAL_WEAK_ALGO", "low",
                `Local user '${pyStr(uname)}' uses MD5 (type 5).`,
                `If the IOS supports it: \`username ${pyStr(uname)} algorithm-type scrypt secret <key>\`.`,
            ));
        }
    }

    if (!users.length) {
        findings.push(_finding(
            name, "NO_LOCAL_USERS", "low",
            "No local users: `login local` on VTY and SSH cannot be used.",
            "Create at least one user with `username <user> secret <key>`.",
        ));
    }

    // --- Global config ---
    if (!pyTruthy(dev.service_password_encryption)) {
        findings.push(_finding(
            name, "NO_SERVICE_PASSWORD_ENCRYPTION", "medium",
            "`service password-encryption` is off: passwords stay in clear text in the config.",
            "Turn it on with `service password-encryption` (it complements `secret`, it doesn't replace it).",
        ));
    }

    if (!pyTruthy(dev.banner_set)) {
        findings.push(_finding(
            name, "NO_BANNER_MOTD", "low",
            "No MOTD banner. In several jurisdictions a legal notice is required to prosecute unauthorized access.",
            "Set `banner motd` (or use pt_apply_hardening with banner_motd).",
        ));
    }

    const reg = dev.config_register !== undefined ? dev.config_register : null;
    if (reg === CONFIG_REGISTER_BYPASS) {
        findings.push(_finding(
            name, "CONFIG_REGISTER_BYPASS", "high",
            `The config-register is 0x${reg.toString(16).padStart(4, "0")}: on the next reboot the device IGNORES the startup-config.`,
            "Restore it with `config-register 0x2102` and save the configuration.",
        ));
    }

    return findings;
}

export function audit_security(devices) {
    /** Audits the security posture of the devices read from the bridge.
     *
     * `devices` is the output of the pt_audit_security reader: a list of dicts with
     * the flags already classified (never credentials). Devices that do not
     * expose IOS configuration (PCs, servers) are discarded before they get here.
     */
    const findings = [];
    for (const dev of devices) {
        findings.push(..._audit_device(dev));
    }

    const counts = { "high": 0, "medium": 0, "low": 0 };
    for (const f of findings) {
        const sev = f["severity"];
        if (Object.prototype.hasOwnProperty.call(counts, sev)) {
            counts[sev] += 1;
        }
    }

    // Sort by severity so the important items come first: the consumer
    // is an LLM that may truncate, and we do not want a high finding to get lost.
    const order = { "high": 0, "medium": 1, "low": 2 };
    findings.sort((a, b) => {
        const oa = order[a["severity"]] !== undefined ? order[a["severity"]] : 9;
        const ob = order[b["severity"]] !== undefined ? order[b["severity"]] : 9;
        if (oa !== ob) return oa - ob;
        if (a["device"] < b["device"]) return -1;
        if (a["device"] > b["device"]) return 1;
        if (a["code"] < b["code"]) return -1;
        if (a["code"] > b["code"]) return 1;
        return 0;
    });

    return {
        "secure": counts["high"] === 0 && counts["medium"] === 0,
        "devices_audited": devices.length,
        "counts": counts,
        "findings": findings,
    };
}
