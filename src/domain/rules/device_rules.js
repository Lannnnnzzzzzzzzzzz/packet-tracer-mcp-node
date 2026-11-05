// Device validation rules.

import { PlanError, ErrorCode } from "../models/errors.js";
import { pyRepr } from "../../shared/pycompat.js";
import { resolve_model } from "../../infrastructure/catalog/devices.js";
import { has_control_chars } from "./text_rules.js";

export function validate_devices(plan) {
    /** Validates that all devices are valid. */
    const errors = [];
    const names_seen = new Set();

    for (const dev of plan.devices) {
        if (has_control_chars(dev.name)) {
            errors.push(new PlanError({
                code: ErrorCode.DEVICE_INVALID_NAME,
                device: dev.name,
                message: `The device name '${dev.name}' contains a line break.`,
                suggestion: "Use a single-line device name.",
            }));
        }

        if (names_seen.has(dev.name)) {
            errors.push(new PlanError({
                code: ErrorCode.DUPLICATE_DEVICE_NAME,
                device: dev.name,
                message: `Duplicate device name: '${dev.name}'`,
                suggestion: "Rename one of the duplicate devices.",
            }));
        }
        names_seen.add(dev.name);

        const model = resolve_model(dev.model);
        if (model === null || model === undefined) {
            errors.push(new PlanError({
                code: ErrorCode.UNKNOWN_DEVICE_MODEL,
                device: dev.name,
                message: `Unknown model '${dev.model}'.`,
                suggestion: (
                    "Use a valid model. " +
                    "Routers: 1841, 1941, 2620XM, 2621XM, 2811, 2901, 2911, " +
                    "819HG-4G-IOX, 819HGW, 829, CGR1240, ISR4321, ISR4331, Router-PT, Router-PT-Empty. " +
                    "Switches: 2950-24, 2950T-24, 2960-24TT, 3560-24PS, 3650-24PS, IE-2000, " +
                    "Switch-PT, Switch-PT-Empty. " +
                    "End devices: PC-PT, Server-PT, Laptop-PT, TabletPC-PT, SMARTPHONE-PT, Printer-PT, " +
                    "WirelessEndDevice-PT, WiredEndDevice-PT, TV-PT, Home-VoIP-PT, Analog-Phone-PT, " +
                    "Embedded-Server-PT. " +
                    "Others: Cloud-PT, Cloud-PT-Empty, AccessPoint-PT, AccessPoint-PT-A, " +
                    "AccessPoint-PT-N, AccessPoint-PT-AC, LAP-PT, 3702i, Hub-PT, Bridge-PT, " +
                    "Repeater-PT, CoAxialSplitter-PT, 5505, 5506-X, WLC-PT, WLC-2504, WLC-3504, " +
                    "DSL-Modem-PT, Cable-Modem-PT, Linksys-WRT300N, HomeRouter-PT-AC, " +
                    "7960, Cell-Tower, Central-Office-Server, 802, 803, Sniffer, " +
                    "MCU-PT, SBC-PT, DLC100, Meraki-MX65W, Meraki-Server, NetworkController, " +
                    "Power Distribution Device, Copper Patch Panel, Fiber Patch Panel, " +
                    "Copper Wall Mount, Fiber Wall Mount, Thing."
                ),
            }));
        }
    }

    // extra_cli: each line is typed as one IOS command, so a line break would smuggle
    // in an unrequested one (`reload`...), and a key with no device is a typo.
    for (const [name, lines] of Object.entries(plan.extra_cli)) {
        if (!names_seen.has(name)) {
            errors.push(new PlanError({
                code: ErrorCode.DEVICE_INVALID_NAME, device: name,
                message: `extra_cli names '${name}', which is not a device of the plan.`,
                suggestion: "Use the exact name of a router or switch in `devices`.",
            }));
        }
        for (const line of lines) {
            if (has_control_chars(line)) {
                errors.push(new PlanError({
                    code: ErrorCode.DEVICE_INVALID_NAME, device: name,
                    message: `extra_cli line for '${name}' contains a line break: ${pyRepr(line)}`,
                    suggestion: "One IOS command per list item.",
                }));
            }
        }
    }

    return errors;
}
