// Device hardening model.

function _wrap(cls, v) {
    if (v === null || v === undefined) return v;
    return v instanceof cls ? v : new cls(v);
}
function _wrapList(cls, v) { return (v || []).map((x) => _wrap(cls, x)); }
function _dict(v) { return v && typeof v.toDict === "function" ? v.toDict() : v; }
function _dictList(v) { return (v || []).map(_dict); }

export class LocalUser {
    constructor(obj = {}) {
        this.username = obj.username !== undefined ? obj.username : undefined;
        this.secret = obj.secret !== undefined ? obj.secret : "";
        this.privilege = obj.privilege !== undefined ? (typeof obj.privilege === "string" ? parseInt(obj.privilege, 10) : obj.privilege) : 1;
    }
    toDict() {
        return { username: this.username, secret: this.secret, privilege: this.privilege };
    }
}

export class SSHConfig {
    constructor(obj = {}) {
        this.domain = obj.domain !== undefined ? obj.domain : "lab.local";
        this.modulus = obj.modulus !== undefined ? (typeof obj.modulus === "string" ? parseInt(obj.modulus, 10) : obj.modulus) : 1024;
        this.version = obj.version !== undefined ? (typeof obj.version === "string" ? parseInt(obj.version, 10) : obj.version) : 2;
        this.enable = obj.enable !== undefined ? obj.enable : true;
    }
    toDict() {
        return { domain: this.domain, modulus: this.modulus, version: this.version, enable: this.enable };
    }
}

export class HardeningConfig {
    /** Hardening config for a router/switch (all optional). */
    constructor(obj = {}) {
        this.device = obj.device !== undefined ? obj.device : undefined;
        this.hostname = obj.hostname !== undefined ? obj.hostname : "";
        this.banner_motd = obj.banner_motd !== undefined ? obj.banner_motd : "";
        this.enable_secret = obj.enable_secret !== undefined ? obj.enable_secret : "";
        this.users = obj.users !== undefined ? _wrapList(LocalUser, obj.users) : [];
        this.ssh = obj.ssh !== undefined && obj.ssh !== null ? _wrap(SSHConfig, obj.ssh) : (obj.ssh !== undefined ? null : null);
        this.service_password_encryption = obj.service_password_encryption !== undefined ? obj.service_password_encryption : true;
        this.console_login_local = obj.console_login_local !== undefined ? obj.console_login_local : true;
        this.vty_ssh_only = obj.vty_ssh_only !== undefined ? obj.vty_ssh_only : true;
    }
    toDict() {
        return {
            device: this.device, hostname: this.hostname, banner_motd: this.banner_motd,
            enable_secret: this.enable_secret, users: _dictList(this.users),
            ssh: this.ssh !== null && this.ssh !== undefined ? _dict(this.ssh) : null,
            service_password_encryption: this.service_password_encryption,
            console_login_local: this.console_login_local, vty_ssh_only: this.vty_ssh_only,
        };
    }
}
