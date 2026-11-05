// Pure helpers behind pt_live_deploy and pt_verify_connectivity (testable without a bridge).
// (Port of infrastructure/execution/live_checks.py)

import { ip_network, ip_interface } from "../../shared/ipnet.js";
import { pyJsonDumps, pyTruthy, pyRepr, pyStr, pyRound, monotonic, sleep as _sleep_ms } from "../../shared/pycompat.js";

// Python time.sleep takes seconds; pycompat's sleep takes milliseconds.
const _default_sleep = (seconds) => _sleep_ms(seconds * 1000);

// New switch ports spend ~30 s in STP listening/learning before they forward, so the
// first ping on a freshly deployed topology needs more than that to finish.
export const PING_TIMEOUT_S = 45.0;

export function device_check_status(reply) {
    /** A getDevice check's reply: 'ok', 'missing', or 'unknown' when it timed out.
     *
     * A timeout is not a missing device: right after a large deploy PT is still running
     * the queued commands, and treating the late answer as MISSING made the reconcile
     * re-create a device that existed (an unconfigured duplicate on the canvas).
     */
    if (reply === "OK") {
        return "ok";
    }
    if (reply === "MISSING") {
        return "missing";
    }
    return "unknown";
}

export function reconcile_commands(commands, names) {
    /** The deploy commands that mention `names`, with every device creation guarded so
     * that re-sending it can never duplicate a device that already exists. */
    const out = [];
    for (let cmd of commands) {
        const hit = [...names].find((n) => cmd.includes(`"${n}"`)) ?? null;
        if (hit === null) {
            continue;
        }
        if (cmd.startsWith("lwAddDevice(")) {
            cmd = `if(!ipc.network().getDevice(${pyJsonDumps(hit)})){${cmd}}`;
        }
        out.push(cmd);
    }
    return out;
}


// --- Deploy verification (one canvas read) ------------------------------------
//
// pt_live_deploy used to check each device and each link with its own round trip
// (and 20 s + 40 s retries per device on a timeout): a 116-device topology meant
// hundreds of trips. Now ONE JS checks every device and link of the plan, with the
// same calls as before (getDevice / getPort / getLink), so the number of trips does
// not grow with the topology.

// Patience for the canvas read: PT may still be running the queued deploy, so a
// timeout is asked again before giving up (and it is never read as "missing").
export const DEPLOY_CHECK_WAITS = [5.0, 20.0, 40.0];

export function deploy_check_js(plan) {
    /** JS reporting `{devices: [1|0 per plan device], links: [status per plan link]}`.
     *
     * Link status: OK, NO_LINK, PORT_MISSING, DEV_MISSING or ERROR (checked on side A,
     * like the per-link check it replaces).
     */
    const cfg = pyJsonDumps({
        "devices": plan.devices.map((d) => d.name),
        "links": plan.links.map((lnk) => [lnk.device_a, lnk.port_a]),
    });
    return (
        "(function(){"
        + `var c=${cfg};var net=ipc.network();var dv=[];var lk=[];`
        + "for(var i=0;i<c.devices.length;i++){var ok=false;"
        + "try{ok=!!net.getDevice(c.devices[i]);}catch(e){ok=false;}dv.push(ok?1:0);}"
        + "for(var j=0;j<c.links.length;j++){var s='ERROR';"
        + "try{var d=net.getDevice(c.links[j][0]);if(!d){s='DEV_MISSING';}"
        + "else{var p=d.getPort(c.links[j][1]);"
        + "s=!p?'PORT_MISSING':(p.getLink()!=null?'OK':'NO_LINK');}}catch(e){s='ERROR';}"
        + "lk.push(s);}"
        + "reportResult(JSON.stringify({devices:dv,links:lk}));"
        + "})();"
    );
}

export async function read_deploy_check(send, plan, waits = DEPLOY_CHECK_WAITS) {
    /** Run deploy_check_js, asking again with more patience on a timeout.
     *
     * None when PT never gave a readable answer: the caller must treat that as
     * "unverified", never as "everything is missing".
     */
    const js = deploy_check_js(plan);
    for (const wait of waits) {
        const raw = await send(js, wait);
        if (raw === null || raw === undefined) {
            continue;
        }
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            return null;
        }
        if (data !== null && typeof data === "object" && !Array.isArray(data)
                && Array.isArray(data["devices"]) && Array.isArray(data["links"])
                && data["devices"].length === plan.devices.length
                && data["links"].length === plan.links.length) {
            return data;
        }
        return null;
    }
    return null;
}

export function link_label(lnk) {
    return `${lnk.device_a}:${lnk.port_a} <-> ${lnk.device_b}:${lnk.port_b}`;
}

export function deploy_check_summary(plan, check) {
    /** (missing device names, failed LinkPlans, failed link labels with their status). */
    const missing = plan.devices.filter((d, i) => !check["devices"][i]).map((d) => d.name);
    const failed = plan.links
        .map((lnk, i) => [lnk, check["links"][i]])
        .filter(([, s]) => s !== "OK");
    return [missing, failed.map(([lnk]) => lnk),
        failed.map(([lnk, s]) => `${link_label(lnk)} (${s})`)];
}

export async function verify_and_reconcile(
    send,
    queue,
    plan,
    commands,
    {
        delay = 0.0,
        sleep = _default_sleep,
    } = {},
) {
    /** Verify a deploy with one canvas read, re-send what is missing, read once more.
     *
     * `queue` sends one fire-and-forget command (already guarded by the caller). An
     * unreadable canvas leaves the result `verified: False` and re-sends NOTHING: a
     * late answer is not a missing device.
     */
    const out = { "verified": false, "dev_ok": 0, "dev_fail": [], "link_ok": 0, "link_fail": [],
           "reconciled_devices": [], "reconciled_links": [] };
    const check = await read_deploy_check(send, plan);
    if (check === null) {
        return out;
    }
    let [dev_fail, link_fail_objs, link_fail] = deploy_check_summary(plan, check);
    if (dev_fail.length || link_fail_objs.length) {
        const names = new Set([
            ...dev_fail,
            ...link_fail_objs.flatMap((lnk) => [lnk.device_a, lnk.device_b]),
        ]);
        for (const cmd of reconcile_commands(commands, names)) {
            await queue(cmd);
            if (delay) {
                await sleep(delay);
            }
        }
        const again = await read_deploy_check(send, plan);
        if (again !== null) {
            const [new_dev_fail, new_link_objs, new_link_fail] = deploy_check_summary(plan, again);
            link_fail = new_link_fail;
            out["reconciled_devices"] = dev_fail.filter((n) => !new_dev_fail.includes(n));
            out["reconciled_links"] = link_fail_objs
                .filter((lnk) => !new_link_objs.includes(lnk))
                .map((lnk) => `${lnk.device_a}:${lnk.port_a}`);
            dev_fail = new_dev_fail;
        }
    }
    out["verified"] = true;
    out["dev_fail"] = dev_fail;
    out["link_fail"] = link_fail;
    out["dev_ok"] = plan.devices.length - dev_fail.length;
    out["link_ok"] = plan.links.length - link_fail.length;
    return out;
}


// --- Opening a .pkt -------------------------------------------------------------
//
// AppWindow.fileOpen(path) returns a FileOpenReturnValue. Cisco documents the names
// (eFileReturnOk, eFileReturnBadSSL, ...) but not their numeric values, so a number
// is never mapped to a name here. The open is judged by what can be read back: the
// documented name when PT gives one, else whether the active file
// (getActiveFile().getSavedFilename(), used by pt_project_metadata) is now the one asked.
export const FILE_OPEN_RESULTS = [
    "Ok", "BadSSL", "BadDecompress", "BadBinary", "BadMetafile", "BadConfiguration",
    "UnableToReadFile", "BadOptions", "UserCancel",
];

export function file_open_js(path) {
    /** JS that opens `path` and reports {ret, before, after, file} (or ERR:does not exist). */
    return (
        "(function(){var fm=ipc.systemFileManager();"
        + `var p=${pyJsonDumps(path)};`
        + "if(!fm.fileExists(p)){reportResult('ERR:does not exist '+p);return;}"
        + "var before=-1;try{before=ipc.network().getDeviceCount();}catch(e){}"
        + "var r=ipc.appWindow().fileOpen(p);"
        + "var after=-1;try{after=ipc.network().getDeviceCount();}catch(e){}"
        + "var f='';try{var af=ipc.appWindow().getActiveFile();f=af?String(af.getSavedFilename()):'';}catch(e){}"
        + "reportResult(JSON.stringify({ret:(r===undefined||r===null)?null:String(r),"
        + "before:before,after:after,file:f}));"
        + "})();"
    );
}

export const DEVICE_COUNT_JS = (
    "try{reportResult(String(ipc.network().getDeviceCount()));}catch(e){reportResult('-1');}"
);

export function file_open_result_name(ret) {
    /** The documented FileOpenReturnValue name in PT's reply, or None (e.g. a bare number). */
    if (ret === null || ret === undefined) {
        return null;
    }
    const key = String(ret).trim().replace(/_/g, "").toLowerCase();
    for (const name of FILE_OPEN_RESULTS) {
        const n = name.toLowerCase();
        if (key === n || key === "efilereturn" + n || key === "filereturn" + n) {
            return name;
        }
    }
    return null;
}

export function save_project_js(directory, name, overwrite) {
    /** Script-Engine JS that saves the active topology as `directory`/`name`.
     *
     * With no directory it uses PT's save folder, but on Linux PT 9.0.1 reports
     * `~/Cisco Packet Tracer 9.0.1/saves`, which does not exist (its real user folder is
     * `~/pt`). Saving there pops a modal "No Write Permission" dialog that blocks PT and
     * the call times out, so a missing default falls back to getUserFolder()/saves
     * (created if needed). fileSaveAsNoPrompt is never called on a folder that is not there.
     */
    return (
        "var aw=ipc.appWindow();var fm=ipc.systemFileManager();"
        + `var dir=${pyJsonDumps(directory)};`
        + "function norm(p){return String(p).replace(/\\\\/g,'/').replace(/\\/+$/,'');}"
        + "if(!dir){dir=norm(aw.getDefaultFileSaveLocation());"
        + "if(!fm.directoryExists(dir)){var uf='';try{uf=norm(aw.getUserFolder());}catch(e){}"
        + "if(uf&&fm.directoryExists(uf)){dir=uf+'/saves';"
        + "if(!fm.directoryExists(dir)){try{fm.makeDirectory(dir);}catch(e){}}}}}"
        + "dir=norm(dir);"
        + `var full=dir+'/'+${pyJsonDumps(name)};`
        + "if(!fm.directoryExists(dir)){reportResult('ERR:folder does not exist '+dir);}"
        + `else if(!${pyJsonDumps(overwrite)}&&fm.fileExists(full)){reportResult('EXISTS:'+full);}else{`
        + "aw.fileSaveAsNoPrompt(full,false);"
        + "reportResult(fm.fileExists(full)?('OK:'+full+'|'+fm.getFileSize(full)):('ERR:not created '+full));}"
    );
}

function _same_path(a, b) {
    const norm = (s) => String(s).trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return Boolean(a) && norm(a) === norm(b);
}

export function file_open_outcome(target, data) {
    /** (opened, explanation) from file_open_js's report. */
    const ret = data["ret"];
    const name = file_open_result_name(ret);
    const active = _same_path(data["file"] ?? "", target);
    if (name !== null && name !== "Ok") {
        return [false, `fileOpen returned ${name}`];
    }
    if (name === "Ok" || active) {
        return [true, `fileOpen returned ${name || pyStr(ret)}`];
    }
    return [false, (
        `fileOpen returned ${pyRepr(ret)} and the active file is `
        + `${pyRepr(data["file"] || "(none)")}, not the requested one`
    )];
}

export function ping_no_result_message(from_device, to_ip, timeout_s) {
    /** What pt_verify_connectivity says when PT never printed the ping statistics. */
    return (
        `${from_device} → ${to_ip}: no result after ${pyRound(timeout_s)}s. `
        + "The ping may still be running. On a topology deployed in the last minute, "
        + "switch ports may still be in STP listening/learning (~30 s): wait and retry, "
        + "or raise timeout_s."
    );
}

export function dhcp_host_ports(plan, static_names) {
    /** {host: port} of the plan's hosts that take their address from a DHCP pool.
     *
     * Same rule as the deploy script: a wired host is DHCP only when a pool serves its
     * subnet; elsewhere it keeps its planned static address and must not be touched.
     */
    const hosts = {};
    if (!pyTruthy(plan.dhcp_pools)) {
        return hosts;
    }
    const pool_nets = plan.dhcp_pools.map((p) => ip_network(`${p.network}/${p.mask}`, false));
    for (const dev of plan.devices) {
        if (!["pc", "server", "laptop"].includes(dev.category) || static_names.has(dev.name)) {
            continue;
        }
        if (pyTruthy(dev.interfaces)) {
            const [port, ip] = Object.entries(dev.interfaces)[0];
            if (ip && pool_nets.some((net) => _ip_in_network(ip_interface(ip).ip, net))) {
                hosts[dev.name] = port;
            }
        } else if (dev["wireless"] ?? false) {
            hosts[dev.name] = "Wireless0";
        }
    }
    return hosts;
}

// Python `addr in net` for ipaddress objects.
function _ip_in_network(addr, net) {
    if (typeof net.contains === "function") {
        return net.contains(addr);
    }
    if (typeof net["__contains__"] === "function") {
        return net["__contains__"](addr);
    }
    // Fall back to network/broadcast bounds from the ipnet port.
    const a = _addr_to_int(addr);
    const lo = _addr_to_int(net.network_address);
    const hi = _addr_to_int(net.broadcast_address);
    return a !== null && lo !== null && hi !== null && a >= lo && a <= hi;
}

function _addr_to_int(addr) {
    if (addr === null || addr === undefined) {
        return null;
    }
    if (typeof addr === "number") {
        return addr;
    }
    const s = String(addr);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) {
        return s.split(".").reduce((acc, part) => ((acc << 8) + (parseInt(part, 10) & 0xff)) >>> 0, 0) >>> 0;
    }
    return null;
}

export async function renew_dhcp_leases(
    send,
    hosts,
    {
        rounds = 2,
        round_s = 15.0,
        sleep = _default_sleep,
        clock = monotonic,
    } = {},
) {
    /** Re-request the lease of every host still at 0.0.0.0: (renewed, still_without_ip).
     *
     * A DHCP host asks for its lease while its switch port is still in STP
     * listening/learning: the DISCOVER is lost and PT does not retry, so the host stays
     * at 0.0.0.0. Call this once STP has settled.
     */
    const { host_ip_config_js, port_state_js } = await import("../generator/host_js.js");

    async function has_ip(name) {
        let state;
        try {
            state = (JSON.parse((await send(port_state_js(name, hosts[name]), 8.0)) || "{}")["state"]) || {};
        } catch (e) {
            return false;
        }
        if (state === null || typeof state !== "object") {
            return false;
        }
        return (state["ip"] || "0.0.0.0") !== "0.0.0.0";
    }

    const renewed = [];
    let pending = [];
    for (const n of Object.keys(hosts)) {
        if (!(await has_ip(n))) {
            pending.push(n);
        }
    }
    for (let round = 0; round < rounds; round++) {
        if (!pending.length) {
            break;
        }
        for (const name of pending) {
            await send(host_ip_config_js(name, hosts[name], { mode: "dhcp" }), 8.0);
        }
        const deadline = clock() + round_s;
        while (pending.length && clock() < deadline) {
            await sleep(1.0);
            const leased = [];
            for (const n of pending) {
                if (await has_ip(n)) {
                    leased.push(n);
                }
            }
            renewed.push(...leased);
            pending = pending.filter((n) => !leased.includes(n));
        }
    }
    return [renewed, pending];
}

export async function read_host_ips(send, hosts) {
    /** {host: IPv4 it holds right now} for each of `hosts` ({host: port}).
     *
     * A host whose port cannot be read is left out, so a missing entry means "unknown",
     * never "0.0.0.0".
     */
    const { port_state_js } = await import("../generator/host_js.js");

    const ips = {};
    for (const [name, port] of Object.entries(hosts)) {
        let state;
        try {
            state = (JSON.parse((await send(port_state_js(name, port), 8.0)) || "{}")["state"]) || {};
        } catch (e) {
            continue;
        }
        if (state === null || typeof state !== "object") {
            continue;
        }
        if (state["ip"]) {
            ips[name] = String(state["ip"]);
        }
    }
    return ips;
}

export function dhcp_address_report(plan, live_ips) {
    /** Report lines with the address each DHCP host REALLY got.
     *
     * The plan's addressing table can only predict a lease: the pool hands addresses in
     * request order, and a DISCOVER lost to STP and asked again can land on another one
     * (measured on PT 9.0.1: planned 192.168.2.2, leased 192.168.2.4). Pings must use
     * these, so every lease is listed and the ones that differ from the table are flagged.
     */
    if (!pyTruthy(live_ips)) {
        return [];
    }
    // Only the hosts that were read: a router or a hand-written plan may hold a value
    // that is not an address, and the deploy already happened by the time this runs.
    const planned = {};
    for (const dev of plan.devices) {
        if (!Object.prototype.hasOwnProperty.call(live_ips, dev.name) || !pyTruthy(dev.interfaces)) {
            continue;
        }
        try {
            planned[dev.name] = String(ip_interface(Object.values(dev.interfaces)[0]).ip);
        } catch (e) {
            // ValueError: not an address; the plan's value is skipped, like Python.
        }
    }
    const parts = [];
    for (const [name, ip] of Object.entries(live_ips)) {
        const want = planned[name];
        if (want && ip !== want && ip !== "0.0.0.0") {
            parts.push(`${name} ${ip} (table said ${want})`);
        } else {
            parts.push(`${name} ${ip}`);
        }
    }
    return [`  DHCP leases (live, use these to ping): ${parts.join(", ")}`];
}

export function dhcp_lease_report(renewed, without_ip) {
    /** pt_live_deploy's report lines for renew_dhcp_leases' result. */
    const lines = [];
    if (renewed.length) {
        lines.push(`  ♻ DHCP lease re-requested after STP: ${renewed.join(", ")}`);
    }
    if (without_ip.length) {
        lines.push(`  ⚠ Hosts still without a DHCP lease: ${without_ip.join(", ")}`);
    }
    return lines;
}


// --- Device console (real ping) ----------------------------------------------
//
// `getCommandPrompt()` ONLY exists on hosts (PC/Server/Laptop). Against a router
// it blows up with `TypeError: Property 'getCommandPrompt' of object is not a
// function`, so pinging from IOS never worked despite being documented.
// Verified against PT 9.0.1: routers expose `getCommandLine()` and PCs
// expose BOTH, so getCommandLine works for both worlds.
//
// The console also has to be primed. A router just deployed by the MCP was never
// touched through its console, so it is still parked at "Would you like to enter the
// initial configuration dialog? [yes/no]:". There the `ping` is consumed as the
// answer to the yes/no and never runs.
const _CONSOLE_PRIME_JS = (
    "var p=String(cl.getPrompt()||'');"
    + "if(p.indexOf('[yes/no]')>=0){cl.enterCommand('no');}"
    + "cl.enterCommand('');"
);


// Statistics block markers, in PT's two formats.
const _PING_STAT_MARKERS = "/Packets: Sent|Success rate/g";

export function console_ping_arm_js(device, target) {
    /** JS that makes the console usable, counts the existing blocks and fires the ping.
     *
     * Returns 'BASE:<n>' with how many statistics blocks there already were: the
     * console keeps history, so markers are counted instead of trusting the length.
     */
    const dev = pyJsonDumps(device);
    const cmd = pyJsonDumps("ping " + target.trim());
    return (
        `var cl=ipc.network().getDevice(${dev}).getCommandLine();`
        + "if(!cl){reportResult('ERR:device has no console');}"
        + "else{"
        + `${_CONSOLE_PRIME_JS}`
        + "var o=String(cl.getOutput());"
        + `var m=o.match(${_PING_STAT_MARKERS});`
        + "var base=m?m.length:0;"
        + `cl.enterCommand(${cmd});`
        + "reportResult('BASE:'+base);}"
    );
}

export function console_ping_poll_js(device, base) {
    /** JS that polls the console until it sees a NEW statistics block. */
    const dev = pyJsonDumps(device);
    return (
        `var cl=ipc.network().getDevice(${dev}).getCommandLine();`
        + "if(!cl){reportResult('ERR:device has no console');}"
        + "else{"
        + "var o=String(cl.getOutput());"
        + `var m=o.match(${_PING_STAT_MARKERS});`
        + "var cur=m?m.length:0;"
        + `if(cur>${Math.trunc(base)}){`
        // raw: the \d and \n belong to the JS regex, they are not Python escapes.
        + "var stat=o.match(/Packets: Sent = \\d+, Received = (\\d+), Lost = (\\d+)[^\\n]*"
        + "|Success rate is (\\d+) percent \\((\\d+)\\/(\\d+)\\)/g);"
        + "reportResult('DONE:'+(stat?stat[stat.length-1]:'no stats'));"
        + "}else{reportResult('WAIT');}}"
    );
}

export function wifi_clients_by_ap(plan) {
    /** {AP: [WiFi clients of its LAN]} when the plan has more than one AP.
     *
     * Every AP-PT broadcasts the same SSID ("Default") and a laptop joins whichever AP
     * it hears first, not the one of its LAN (measured on PT 9.0.1: LT3 and LT4, planned
     * for LAN 2, leased 192.168.0.x from LAN 1, with the old layout and the new one
     * alike). The planner records each client's AP in DevicePlan.ap.
     */
    const aps = new Set(plan.devices.filter((d) => d.category === "accesspoint").map((d) => d.name));
    if (aps.size < 2) {
        return {};
    }
    const out = {};
    for (const d of plan.devices) {
        const ap = d["ap"] ?? "";
        if ((d["wireless"] ?? false) && aps.has(ap)) {
            if (!Object.prototype.hasOwnProperty.call(out, ap)) {
                out[ap] = [];
            }
            out[ap].push(d.name);
        }
    }
    return out;
}

export function wireless_macs_js(devices) {
    /** {device: MAC of its Wireless0} for each device; a missing one is left out. */
    const cfg = pyJsonDumps({ "devices": devices });
    return (
        "(function(){try{"
        + `var c=${cfg};var net=ipc.network();var r={};`
        + "for(var i=0;i<c.devices.length;i++){try{var d=net.getDevice(c.devices[i]);"
        + "var p=d?d.getPort('Wireless0'):null;if(p){r[c.devices[i]]=String(p.getMacAddress());}}catch(e){}}"
        + "reportResult(JSON.stringify(r));"
        + "}catch(e){reportResult('{}');}})();"
    );
}

export function power_cycle_js(devices) {
    /** Turn each device off and on again (skipping the boot); answers the ones cycled. */
    const cfg = pyJsonDumps({ "devices": devices });
    return (
        "(function(){try{"
        + `var c=${cfg};var net=ipc.network();var done=[];`
        + "for(var i=0;i<c.devices.length;i++){try{var d=net.getDevice(c.devices[i]);if(!d){continue;}"
        + "d.setPower(false);d.setPower(true);if(typeof d.skipBoot==='function'){d.skipBoot();}"
        + "done.push(c.devices[i]);}catch(e){}}"
        + "reportResult(JSON.stringify(done));"
        + "}catch(e){reportResult('[]');}})();"
    );
}

export async function pin_wifi_clients(send, plan) {
    /** Keep each WiFi laptop on the AP of its LAN, then have it ask for a new lease.
     *
     * Each AP gets a MAC filter that allows only its own laptops (the same setting as
     * pt_wireless_ap; measured: LT3/LT4 moved from 192.168.0.x to 192.168.1.x), and
     * every pinned laptop re-requests DHCP. Returns report lines.
     */
    const { host_ip_config_js } = await import("../generator/host_js.js");
    const { wireless_ap_js } = await import("../generator/wireless_js.js");

    const groups = wifi_clients_by_ap(plan);
    if (!pyTruthy(groups)) {
        return [];
    }
    const names = Object.values(groups).flat();
    let macs;
    try {
        macs = JSON.parse((await send(wireless_macs_js(names), 8.0)) || "{}");
    } catch (e) {
        macs = {};
    }
    const pinned = [];
    const failed = [];
    for (const [ap, clients] of Object.entries(groups)) {
        const allowed = clients.filter((n) => Object.prototype.hasOwnProperty.call(macs, n)).map((n) => macs[n]);
        if (!allowed.length) {
            failed.push(ap);
            continue;
        }
        const raw = await send(wireless_ap_js(ap, { mac_filter: true, allow_listed: true, mac_list: allowed }), 8.0);
        let ok;
        try {
            const after = (JSON.parse(raw || "{}")["after"]) || {};
            if (after === null || typeof after !== "object") {
                throw new Error("unexpected reply");
            }
            const mac_list = after["mac_list"] || [];
            ok = Boolean(after["mac_filter"]) && allowed.every((m) => mac_list.includes(m));
        } catch (e) {
            ok = false;
        }
        (ok ? pinned : failed).push(ap);
    }
    // A client an AP has just refused stays unassociated (APIPA 169.254.x) and never tries
    // the other AP on its own; a power cycle makes it scan again (measured on PT 9.0.1:
    // LT1 went from 169.254.167.174 to 192.168.0.8). Then it asks for a lease.
    await send(power_cycle_js(names), 8.0);
    for (const n of names) {
        await send(host_ip_config_js(n, "Wireless0", { mode: "dhcp" }), 8.0);
    }
    const lines = [];
    if (pinned.length) {
        lines.push("  📶 WiFi clients pinned to their LAN's AP (MAC filter): "
            + pinned.map((ap) => `${ap} ← ${groups[ap].join("/")}`).join(", "));
    }
    if (failed.length) {
        lines.push(`  ⚠ Could not pin the clients of ${failed.join(", ")}: they may join `
            + "another LAN's AP. Fix with pt_wireless_ap(mac_filter=True, allow_listed=True, mac_list=[...]).");
    }
    return lines;
}
