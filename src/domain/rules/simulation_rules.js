// Validation for traffic the MCP originates itself (pt_send_pdu).
//
// The device names travel to `addSimplePdu` through json.dumps, so this is not
// about escaping: it catches the requests PT would only answer with a bare code.

import { ErrorCode, PlanError, ValidationResult } from "../models/errors.js";
import { pyRepr } from "../../shared/pycompat.js";
import { has_control_chars } from "./text_rules.js";

export const MAX_PDU_STEPS = 100;

export function validate_send_pdu(source, destination, steps) {
    const errors = [];

    function bad(code, msg, hint = "", device = "") {
        errors.push(new PlanError({ code: code, device: device, message: msg, suggestion: hint }));
    }

    for (const [name, value] of [["source", source], ["destination", destination]]) {
        if (!(value || "").trim()) {
            bad(ErrorCode.DEVICE_INVALID_NAME, `'${name}' is empty.`,
                "Pass the device name exactly as pt_query_topology lists it.");
        } else if (has_control_chars(value) || value.includes("\x00")) {
            bad(ErrorCode.DEVICE_INVALID_NAME, `'${name}' contains a newline or NUL.`);
        }
    }
    if ((source || "").trim() && (source || "").trim() === (destination || "").trim()) {
        bad(ErrorCode.PANEL_INVALID_VALUE, "source and destination are the same device.",
            "A simple PDU goes from one device to another.", source.trim());
    }
    if (typeof steps === "boolean" || typeof steps !== "number" || !Number.isInteger(steps) || !(0 <= steps && steps <= MAX_PDU_STEPS)) {
        bad(ErrorCode.PANEL_INVALID_VALUE, `steps=${pyRepr(steps)} is out of range (0-${MAX_PDU_STEPS}).`);
    }
    return new ValidationResult({ errors: errors });
}
