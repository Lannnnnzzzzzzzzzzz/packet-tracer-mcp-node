// EtherChannel validation (measured on a 2960-24TT in PT 9).

import { ETHERCHANNEL_MODES } from "../models/etherchannel.js";
import { PlanError, ErrorCode, ValidationResult } from "../models/errors.js";
import { pyRepr, pyStr } from "../../shared/pycompat.js";
import { resolve_model } from "../../infrastructure/catalog/devices.js";

export const MEASURED_SWITCH = "2960-24TT";
// Port-channel numbers a 2960 accepts; other IOS switches go higher.
export const GROUP_MAX_2960 = 6;
export const GROUP_MAX = 48;
export const MAX_MEMBERS = 8;

export const PORT_RE = /^(FastEthernet|GigabitEthernet)(\d+\/)*\d+$/;

export function port_kind(port) {
    /** 'FastEthernet' or 'GigabitEthernet' (mixed speeds never bundle). */
    const m = PORT_RE.exec(port);
    return m ? m[1] : "";
}

export function validate_etherchannel(cfg) {
    const errors = [];
    const warnings = [];
    if (!ETHERCHANNEL_MODES.includes(cfg.mode)) {
        errors.push(new PlanError({
            code: ErrorCode.ETHERCHANNEL_INVALID_MODE, device: cfg.switch,
            message: `mode '${cfg.mode}' is not a channel-group mode.`,
            suggestion: "LACP: active|passive. PAgP: desirable|auto. Static: on.",
        }));
    }
    if (!(1 <= cfg.group && cfg.group <= GROUP_MAX)) {
        errors.push(new PlanError({
            code: ErrorCode.ETHERCHANNEL_INVALID_GROUP, device: cfg.switch,
            message: `group ${cfg.group} out of range (1-${GROUP_MAX}; a 2960 takes 1-${GROUP_MAX_2960}).`,
            suggestion: "Use a small number such as 1; it becomes Port-channel<group>.",
        }));
    }
    if (cfg.ports.length < 2) {
        errors.push(new PlanError({
            code: ErrorCode.ETHERCHANNEL_INVALID_PORTS, device: cfg.switch,
            message: `An EtherChannel needs at least 2 ports (${cfg.ports.length} given).`,
            suggestion: 'Pass e.g. ports=["FastEthernet0/10", "FastEthernet0/11"].',
        }));
    } else if (cfg.ports.length > MAX_MEMBERS) {
        errors.push(new PlanError({
            code: ErrorCode.ETHERCHANNEL_INVALID_PORTS, device: cfg.switch,
            message: `${cfg.ports.length} ports: an EtherChannel bundles at most ${MAX_MEMBERS}.`,
            suggestion: `Use ${MAX_MEMBERS} ports or fewer.`,
        }));
    }
    const bad = cfg.ports.filter((p) => !port_kind(p));
    if (bad.length) {
        errors.push(new PlanError({
            code: ErrorCode.ETHERCHANNEL_INVALID_PORTS, device: cfg.switch,
            message: `Not a full Ethernet port name: ${bad.map((p) => pyRepr(p)).join(", ")}.`,
            suggestion: "Use full names such as 'FastEthernet0/10' or 'GigabitEthernet0/1'.",
        }));
    } else {
        const dupes = [...new Set(cfg.ports.filter((p) => cfg.ports.filter((x) => x === p).length > 1))]
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        if (dupes.length) {
            errors.push(new PlanError({
                code: ErrorCode.ETHERCHANNEL_INVALID_PORTS, device: cfg.switch,
                message: `Port(s) listed twice: ${dupes.join(", ")}.`,
                suggestion: "Give each port once.",
            }));
        }
        if (new Set(cfg.ports.map((p) => port_kind(p))).size > 1) {
            errors.push(new PlanError({
                code: ErrorCode.ETHERCHANNEL_INVALID_PORTS, device: cfg.switch,
                message: "The ports mix FastEthernet and GigabitEthernet.",
                suggestion: "Members must share speed and duplex, or IOS suspends them.",
            }));
        }
    }
    if (cfg.allowed_vlans !== null && cfg.allowed_vlans !== undefined) {
        if (!cfg.trunk) {
            errors.push(new PlanError({
                code: ErrorCode.ETHERCHANNEL_INVALID_VLAN, device: cfg.switch,
                message: "allowed_vlans only applies to a trunk.",
                suggestion: "Pass trunk=True or drop allowed_vlans.",
            }));
        }
        const bad_vlans = cfg.allowed_vlans.filter((v) => !(1 <= v && v <= 4094));
        if (bad_vlans.length || !cfg.allowed_vlans.length) {
            errors.push(new PlanError({
                code: ErrorCode.ETHERCHANNEL_INVALID_VLAN, device: cfg.switch,
                message: `Invalid allowed_vlans ${bad_vlans.length ? pyRepr(bad_vlans) : cfg.allowed_vlans}.`,
                suggestion: "Give VLAN ids between 1 and 4094.",
            }));
        }
    }
    if (cfg.mode === "on") {
        warnings.push(new PlanError({
            code: ErrorCode.ETHERCHANNEL_INVALID_MODE, device: cfg.switch,
            message: "mode 'on' negotiates nothing: a mismatch with the peer can loop or drop.",
            suggestion: "Prefer LACP (active on one side, active or passive on the other).",
        }));
    }
    return new ValidationResult({ errors: errors, warnings: warnings });
}

export function validate_etherchannel_against_topology(cfg, devices_in_pt) {
    const errors = [];
    const warnings = [];
    const dev = devices_in_pt.find((d) => d["name"] === cfg.switch) ?? null;
    if (dev === null) {
        errors.push(new PlanError({
            code: ErrorCode.ETHERCHANNEL_SWITCH_NOT_FOUND, device: cfg.switch,
            message: `Switch '${cfg.switch}' does not exist in the active topology.`,
            suggestion: "Call pt_query_topology to see the real names.",
        }));
        return new ValidationResult({ errors: errors });
    }
    const model = resolve_model(dev["model"] ?? "");
    if (model !== null && model !== undefined) {
        if (model.category !== "switch") {
            errors.push(new PlanError({
                code: ErrorCode.FEATURE_UNSUPPORTED_DEVICE, device: cfg.switch,
                message: `'${cfg.switch}' is a ${dev["model"]}, not a switch.`,
                suggestion: "EtherChannel here is for switches (measured on a 2960-24TT).",
            }));
            return new ValidationResult({ errors: errors });
        }
        if (model.pt_type === MEASURED_SWITCH && cfg.group > GROUP_MAX_2960) {
            errors.push(new PlanError({
                code: ErrorCode.ETHERCHANNEL_INVALID_GROUP, device: cfg.switch,
                message: `A 2960 takes channel-group 1-${GROUP_MAX_2960}, not ${cfg.group}.`,
                suggestion: `Use a group between 1 and ${GROUP_MAX_2960}.`,
            }));
        } else if (model.pt_type !== MEASURED_SWITCH) {
            warnings.push(new PlanError({
                code: ErrorCode.FEATURE_UNSUPPORTED_DEVICE, device: cfg.switch,
                message: `EtherChannel was measured on a 2960-24TT only; ${dev["model"]} ` +
                        "is NOT verified.",
                suggestion: "Check the reply's rejected_lines and `show etherchannel summary`.",
            }));
        }
    }
    const live = {};
    for (const p of dev["ports"] || []) if (p["name"]) live[p["name"]] = p;
    const valid = new Set(Object.keys(live).length ? Object.keys(live) : (model ? model.ports.map((p) => p.full_name) : []));
    const missing = cfg.ports.filter((p) => valid.size && !valid.has(p));
    if (missing.length) {
        errors.push(new PlanError({
            code: ErrorCode.ETHERCHANNEL_PORT_NOT_FOUND, device: cfg.switch,
            message: `Port(s) not on ${dev["model"]}: ${missing.join(", ")}.`,
            suggestion: "Check the ports with pt_get_device_details.",
        }));
    }
    const unlinked = cfg.ports.filter((p) => (p in live) && live[p]["linked"] === false);
    if (unlinked.length) {
        warnings.push(new PlanError({
            code: ErrorCode.ETHERCHANNEL_INVALID_PORTS, device: cfg.switch,
            message: `Port(s) without a cable: ${unlinked.join(", ")}.`,
            suggestion: "The bundle only comes up once every member is cabled to the peer.",
        }));
    }
    return new ValidationResult({ errors: errors, warnings: warnings });
}
