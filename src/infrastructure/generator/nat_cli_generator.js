// IOS CLI generator for NAT/PAT.
//
// Produces the IOS commands that are applied via `configureIosDevice` through
// the bridge. Same contract as acl_cli_generator:
//
//   1. `generate_nat_interface_cli(config)` → list[str] of IOS lines.
//   2. `generate_nat_body_cli(config)`      → list[str] of IOS lines.
//   3. `build_nat_configure_payload(config)` → full string with internal \n,
//      ready to inject as the second argument of configureIosDevice.
//
// Critical constraint: the payload MUST travel inside a single JS statement
// (no real \n in the JS code). The \n here are string-literal escapes
// — not source-code line breaks — so executeCode() does NOT strip them.

import { pyJsonDumps, pyTruthy } from "../../shared/pycompat.js";

export function generate_nat_interface_cli(config) {
    // Generates the commands that mark interfaces inside/outside.
    return [
        `interface ${config.inside_interface}`,
        " ip nat inside",
        " exit",
        `interface ${config.outside_interface}`,
        " ip nat outside",
        " exit",
    ];
}

export function generate_nat_body_cli(config) {
    // Generates the inline ACL (if applicable), pool and ip nat inside source command.
    const lines = [];

    if (config.mode === "static") {
        for (const m of config.static_mappings) {
            lines.push(
                `ip nat inside source static ${m.inside_local} ${m.inside_global}`
            );
        }
        return lines;
    }

    // dynamic / pat — generate the access-list inline if networks are defined
    if (pyTruthy(config.inside_networks)) {
        for (const net of config.inside_networks) {
            lines.push(`access-list ${config.acl_number} permit ${net}`);
        }
    }

    if (config.mode === "dynamic") {
        const pool = config.pool;
        lines.push(
            `ip nat pool ${pool.name} ${pool.start_ip} ${pool.end_ip} `
            + `netmask ${pool.netmask}`
        );
        lines.push(
            `ip nat inside source list ${config.acl_number} pool ${pool.name}`
        );
    } else if (config.mode === "pat") {
        if (config.use_interface_overload) {
            lines.push(
                `ip nat inside source list ${config.acl_number} `
                + `interface ${config.outside_interface} overload`
            );
        } else {
            const pool = config.pool;
            lines.push(
                `ip nat pool ${pool.name} ${pool.start_ip} ${pool.end_ip} `
                + `netmask ${pool.netmask}`
            );
            lines.push(
                `ip nat inside source list ${config.acl_number} `
                + `pool ${pool.name} overload`
            );
        }
    }

    return lines;
}

export function build_nat_configure_payload(config) {
    // Builds the full string for configureIosDevice.
    //
    // Structure:
    //     enable
    //     configure terminal
    //     <interface inside/outside>
    //     <nat body (static mappings or ACL + pool/overload)>
    //     end
    //     write memory
    //
    // The lines are joined with real \n. This string IS PASSED as an argument
    // to configureIosDevice; the \n here are NOT part of the JS code.
    const lines = ["enable", "configure terminal"];
    lines.push(...generate_nat_interface_cli(config));
    lines.push(...generate_nat_body_cli(config));
    lines.push("end");
    lines.push("write memory");
    return lines.join("\n");
}

export function build_nat_remove_payload(
    router,
    mode,
    inside_interface,
    outside_interface,
    acl_number = "1",
    pool_name = "",
    static_mappings = null,
) {
    // Builds commands to remove the NAT configuration from a router.
    const lines = ["enable", "configure terminal"];

    // Remove the inside/outside marks from interfaces
    lines.push(
        `interface ${inside_interface}`,
        " no ip nat inside",
        " exit",
        `interface ${outside_interface}`,
        " no ip nat outside",
        " exit",
    );

    if (mode === "static" && pyTruthy(static_mappings)) {
        for (const m of static_mappings) {
            const inside_local = m["inside_local"] !== undefined && m["inside_local"] !== null ? m["inside_local"] : "";
            const inside_global = m["inside_global"] !== undefined && m["inside_global"] !== null ? m["inside_global"] : "";
            if (pyTruthy(inside_local) && pyTruthy(inside_global)) {
                lines.push(
                    `no ip nat inside source static ${inside_local} ${inside_global}`
                );
            }
        }
    } else if (mode === "dynamic") {
        if (pyTruthy(pool_name)) {
            lines.push(`no ip nat inside source list ${acl_number} pool ${pool_name}`);
            lines.push(`no ip nat pool ${pool_name}`);
        }
        lines.push(`no access-list ${acl_number}`);
    } else if (mode === "pat") {
        if (pyTruthy(pool_name)) {
            lines.push(
                `no ip nat inside source list ${acl_number} pool ${pool_name} overload`
            );
            lines.push(`no ip nat pool ${pool_name}`);
        } else {
            lines.push(
                `no ip nat inside source list ${acl_number} `
                + `interface ${outside_interface} overload`
            );
        }
        lines.push(`no access-list ${acl_number}`);
    }

    lines.push("end");
    lines.push("write memory");
    return lines.join("\n");
}

export function build_nat_js_call(router, ios_payload) {
    // Wraps the IOS payload in a configureIosDevice call as a single JS line.
    //
    // The \n inside the payload are escaped to \\n so they travel as
    // content of the JS string literal — executeCode() strips REAL line breaks
    // in source code, but not escape sequences inside strings.
    // json.dumps per value: it also escapes \r, U+2028/2029 and control
    // characters, which the old hand-written escaping let through.
    return `configureIosDevice(${pyJsonDumps(router)}, ${pyJsonDumps(ios_payload)});`;
}
