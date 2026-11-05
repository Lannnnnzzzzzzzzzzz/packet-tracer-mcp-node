// Topology plan validator.
//
// Uses the rules in domain/rules/ with typed errors.

import { ValidationResult } from "../models/errors.js";
import { validate_devices } from "../rules/device_rules.js";
import { validate_ips, validate_dhcp } from "../rules/ip_rules.js";
import { validate_links } from "../rules/cable_rules.js";
import {
    validate_connectivity, validate_routing, validate_wireless,
} from "../rules/topology_rules.js";

// Python issue.code.value: in JS the code is the plain string already; accept
// either shape so the check works whichever the errors port stores.
function _code_value(code) {
    if (code !== null && typeof code === "object") return code.value;
    return code;
}

export function validate_plan(plan) {
    /**
     * Validates a complete plan.
     * Returns a ValidationResult with typed errors and warnings.
     * Also updates plan.errors and plan.warnings for compatibility.
     */
    const result = new ValidationResult();

    // Devices
    result.errors.push(...validate_devices(plan));

    // Links and cables
    const [link_errors, link_warnings] = validate_links(plan);
    result.errors.push(...link_errors);
    result.warnings.push(...link_warnings);

    // IPs
    result.errors.push(...validate_ips(plan));

    // DHCP
    const dhcp_issues = validate_dhcp(plan);
    // DHCP gateway mismatch is a warning, not a critical error
    for (const issue of dhcp_issues) {
        if (_code_value(issue.code) === "DHCP_GATEWAY_MISMATCH") {
            result.warnings.push(issue);
        } else {
            result.errors.push(issue);
        }
    }

    // Graph shape: islands and inconsistent routing. It runs last because it assumes
    // that devices and links have already been validated one at a time.
    result.errors.push(...validate_connectivity(plan));
    result.errors.push(...validate_routing(plan));
    // Warning: this is a PT limitation, not a plan error.
    result.warnings.push(...validate_wireless(plan));

    // Sync with plan.errors/warnings for compatibility
    plan.errors = result.error_messages();
    plan.warnings = result.warning_messages();

    return result;
}
