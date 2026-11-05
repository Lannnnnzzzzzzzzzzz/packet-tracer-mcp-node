// EtherChannel (port-channel) model for a switch.

// channel-group modes: LACP (active/passive), PAgP (desirable/auto) and static (on).
export const LACP_MODES = ["active", "passive"];
export const PAGP_MODES = ["desirable", "auto"];
export const ETHERCHANNEL_MODES = [...LACP_MODES, ...PAGP_MODES, "on"];

export class EtherChannelConfig {
    /** Bundle `ports` of `switch` into Port-channel<group>. */
    constructor(obj = {}) {
        this.switch = obj.switch !== undefined ? obj.switch : undefined;
        this.ports = obj.ports !== undefined ? [...obj.ports] : [];
        this.group = obj.group !== undefined ? (typeof obj.group === "string" ? parseInt(obj.group, 10) : obj.group) : 1;
        this.mode = obj.mode !== undefined ? obj.mode : "active";
        this.trunk = obj.trunk !== undefined ? obj.trunk : false;
        this.allowed_vlans = obj.allowed_vlans !== undefined && obj.allowed_vlans !== null ? [...obj.allowed_vlans] : (obj.allowed_vlans !== undefined ? null : null);
    }
    protocol() {
        if (LACP_MODES.includes(this.mode)) {
            return "LACP";
        }
        if (PAGP_MODES.includes(this.mode)) {
            return "PAgP";
        }
        return "static";
    }
    toDict() {
        return {
            switch: this.switch, ports: [...this.ports], group: this.group,
            mode: this.mode, trunk: this.trunk,
            allowed_vlans: this.allowed_vlans !== null && this.allowed_vlans !== undefined ? [...this.allowed_vlans] : null,
        };
    }
}
