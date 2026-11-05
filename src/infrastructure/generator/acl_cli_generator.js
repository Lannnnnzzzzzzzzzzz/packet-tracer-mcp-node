// IOS CLI generator for ACLs.
//
// Produces the `access-list` / `ip access-list` and `ip access-group` commands that are applied via
// `configureIosDevice` through the bridge. The output can be consumed in
// two ways:
//
//   1. `generate_acl_cli(plan)` → list[str] of IOS lines for review.
//   2. `build_configure_payload(plan, binding=None)` → a complete string
//      already formatted with internal \n, ready to inject as the second
//      argument of configureIosDevice. Important: this string MUST
//      travel inside a single JS statement (no \n in the JS code),
//      because PT's executeCode() strips the \n from JS source code.

import { pyTruthy } from "../../shared/pycompat.js";

export function is_named_acl(name_or_number) {
    // A name, not a number: IOS only takes it through `ip access-list`.
    return !/^\d+$/.test(String(name_or_number).trim());
    // Python: not str(name_or_number).strip().isdigit() — str.isdigit() also
    // accepts some non-ASCII digits; ACL ids here are ASCII, kept as \d.
}

export function generate_acl_statements(plan) {
    // Each entry as its bare statement (`remark ...`, `permit ...`), no ACL prefix.
    //
    // Shared by both CLI forms and by the object backend (AclProcess.addStatement).
    const statements = [];
    for (const entry of plan.entries) {
        if (pyTruthy(entry.remark)) {
            statements.push(`remark ${entry.remark}`);
        }
        statements.push(_render_entry(plan.acl_type, entry));
    }
    return statements;
}

export function generate_acl_cli(plan) {
    // Generates the lines that define an ACLPlan.
    //
    // Numbered: one `access-list N ...` line per statement. Named: IOS rejects
    // `access-list NAME ...` (it only takes numbers there), so the ACL is opened with
    // `ip access-list standard|extended NAME` and each statement goes inside it.
    // Does not include `enable`, `configure terminal` or `end`.
    const statements = generate_acl_statements(plan);
    if (is_named_acl(plan.name_or_number)) {
        return (
            [`ip access-list ${plan.acl_type} ${plan.name_or_number}`]
            .concat(statements.map((st) => ` ${st}`))
            .concat([" exit"])
        );
    }
    return statements.map((st) => `access-list ${plan.name_or_number} ${st}`);
}

export function generate_acl_binding_cli(binding) {
    // Generates the lines that apply an ACL to an interface.
    //
    // Output:
    //     interface <iface>
    //      ip access-group <id> <direction>
    //      exit
    return [
        `interface ${binding.interface}`,
        ` ip access-group ${binding.acl_id} ${binding.direction}`,
        " exit",
    ];
}

export function build_configure_payload(plan, binding = null) {
    // Builds the complete string for configureIosDevice.
    //
    // Structure:
    //     enable
    //     configure terminal
    //     <access-list lines>
    //     [interface ... / ip access-group ... / exit]
    //     end
    //     write memory
    //
    // The lines are joined with `\n` (real newlines). This string IS PASSED
    // as an argument to configureIosDevice; the `\n` here are NOT the `\n`
    // of the JS code (executeCode() strips those), but characters inside a
    // string that IOS interprets as Enter.
    const lines = ["enable", "configure terminal"];
    lines.push(...generate_acl_cli(plan));
    if (binding !== null && binding !== undefined) {
        lines.push(...generate_acl_binding_cli(binding));
    }
    lines.push("end");
    lines.push("write memory");
    return lines.join("\n");
}

export function build_remove_payload(router, name_or_number, binding_interface = "", direction = "in") {
    // Builds commands to remove an ACL (and its binding, if any).
    const lines = ["enable", "configure terminal"];
    if (pyTruthy(binding_interface)) {
        lines.push(`interface ${binding_interface}`);
        lines.push(` no ip access-group ${name_or_number} ${direction}`);
        lines.push(" exit");
    }
    if (is_named_acl(name_or_number)) {
        // The type is not known here; IOS ignores the one that does not match.
        lines.push(`no ip access-list standard ${name_or_number}`);
        lines.push(`no ip access-list extended ${name_or_number}`);
    } else {
        lines.push(`no access-list ${name_or_number}`);
    }
    lines.push("end");
    lines.push("write memory");
    return lines.join("\n");
}

// ----------------------------------------------------------------------
// Private helpers
// ----------------------------------------------------------------------

function _render_entry(acl_type, entry) {
    // Renders an entry as an IOS statement, without the `access-list N` prefix.
    const parts = [];

    if (entry.sequence !== null && entry.sequence !== undefined) {
        // IOS standard: sequences are handled with `ip access-list` in named mode.
        // For the traditional `access-list NN` the order is implicit.
        // We keep sequence as a hint but do not emit it in numbered format.
    }

    parts.push(entry.action);

    if (acl_type === "standard") {
        // Standard: `access-list N {permit|deny} <source>`
        parts.push(entry.source);
    } else {
        // Extended: `access-list N {permit|deny} <protocol> <source> [src-port] <dest> [dst-port] [icmp-type] [flags] [log]`
        parts.push(entry.protocol);
        parts.push(entry.source);
        if (pyTruthy(entry.source_port_op)) {
            parts.push(_render_port(entry.source_port_op, entry.source_port, entry.source_port_end));
        }
        parts.push(pyTruthy(entry.destination) ? entry.destination : "any");
        if (pyTruthy(entry.dest_port_op)) {
            parts.push(_render_port(entry.dest_port_op, entry.dest_port, entry.dest_port_end));
        }
        if (pyTruthy(entry.icmp_type)) {
            parts.push(entry.icmp_type);
        }
        for (const flag of entry.tcp_flags) {
            parts.push(flag);
        }
    }

    if (pyTruthy(entry.log)) {
        parts.push("log");
    }

    return parts.join(" ");
}

function _render_port(op, port, port_end) {
    if (op === "range") {
        return `range ${port} ${port_end}`;
    }
    return `${op} ${port}`;
}
