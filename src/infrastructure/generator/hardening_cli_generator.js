// Generador CLI para hardening de dispositivos.

import { pyJsonDumps, pyTruthy } from "../../shared/pycompat.js";

export function generate_hardening_cli(cfg) {
    const lines = [];

    if (pyTruthy(cfg.hostname)) {
        lines.push(`hostname ${cfg.hostname}`);
    }

    if (cfg.service_password_encryption) {
        lines.push("service password-encryption");
    }

    if (pyTruthy(cfg.enable_secret)) {
        lines.push(`enable secret ${cfg.enable_secret}`);
    }

    for (const u of cfg.users) {
        lines.push(`username ${u.username} privilege ${u.privilege} secret ${u.secret}`);
    }

    // SSH: requiere hostname + domain-name + claves RSA
    if (cfg.ssh && cfg.ssh.enable) {
        const host = cfg.hostname || cfg.device;
        // hostname ya emitido arriba si se dio; aseguramos domain-name + claves
        lines.push(`ip domain-name ${cfg.ssh.domain}`);
        lines.push(`crypto key generate rsa modulus ${cfg.ssh.modulus}`);
        lines.push(`ip ssh version ${cfg.ssh.version}`);
    }

    if (pyTruthy(cfg.banner_motd)) {
        // delimitador # (el texto no debe contener #)
        lines.push(`banner motd #${cfg.banner_motd}#`);
    }

    if (cfg.console_login_local && pyTruthy(cfg.users)) {
        lines.push("line console 0");
        lines.push(" login local");
        lines.push(" exit");
    }

    if (cfg.vty_ssh_only && cfg.ssh && cfg.ssh.enable) {
        lines.push("line vty 0 4");
        lines.push(" transport input ssh");
        lines.push(" login local");
        lines.push(" exit");
    }

    return lines;
}

export function build_hardening_payload(cfg) {
    return ["enable", "configure terminal", ...generate_hardening_cli(cfg), "end", "write memory"].join("\n");
}

export function build_hardening_js_call(device, ios_payload) {
    // json.dumps per value: it also escapes \r, U+2028/2029 and control
    // characters, which the old hand-written escaping let through.
    return `configureIosDevice(${pyJsonDumps(device)}, ${pyJsonDumps(ios_payload)});`;
}
