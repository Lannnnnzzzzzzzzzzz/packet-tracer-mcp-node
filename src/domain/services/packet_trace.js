// Reading PT's simulation event list: what each packet did and why.
//
// Pure logic, no bridge — testable with synthetic dicts, like topology_diff.
//
// What makes this useful is not the packet list but the decision log: PT
// exposes, per frame and per OSI layer, the same prose explanation it shows in the
// "PDU Details" panel of its GUI. Verified against PT 9.0.0.0810 with a ping from
// PC1 to its gateway:
//
//     L3 :: The source IP address is not specified. The device sets it to the port's IP address.
//     L3 :: The destination IP address is in the same subnet. The device sets the next-hop to destination.
//     L2 :: The next-hop IP address is not in the ARP table. The ARP process ... buffers this packet.
//
// That turns "the ping does not work" into a concrete cause.

import { ip_address } from "../../shared/ipnet.js";
import { pyStr, pyTruthy } from "../../shared/pycompat.js";

// getUserTrafficType() returns the TrafficType enum as an integer. The names come from
// Cisco's IPC reference (FrameInstance.getUserTrafficType / Simulation.newFrameInstanceAdded,
// eTrafficType_*). MEASURED against PT 9: 0 ICMP and 5 ARP (ping from PC1 to its gateway),
// 11 STP and 12 OSPF (BPDUs and hellos in the event list). Every measured value matched the
// documented enum, which is why the rest is taken from it. A value outside the enum is
// passed through as `type<N>` instead of inventing a name.
export const TRAFFIC_TYPES = {
    0: "ICMP", 1: "TCP", 2: "UDP", 3: "RIPv1", 4: "RIPv2", 5: "ARP", 6: "CDP",
    7: "DHCP", 8: "NAT", 9: "EIGRP", 10: "VTP", 11: "STP", 12: "OSPF", 13: "DTP",
    14: "Telnet", 15: "SSH", 16: "TFTP", 17: "HTTP", 18: "HTTPS", 19: "DNS",
    20: "ICMPv6", 21: "LACP", 22: "PAgP", 23: "IPsec", 24: "IKE", 25: "Syslog",
    26: "TACACS", 27: "RADIUS", 28: "SNMP", 29: "NTP", 30: "FTP", 31: "SMTP",
    32: "POP3", 33: "SCCP", 34: "RTP", 35: "H.323", 36: "BGP", 37: "HSRP",
    38: "HSRPv6", 39: "NetFlow", 40: "NDv6", 41: "RIPng", 42: "DHCPv6",
    43: "EIGRPv6", 44: "OSPFv6", 45: "IoE", 46: "PTP", 47: "REP", 48: "CAPWAP-UDP",
    49: "LLDP", 50: "SPAN", 51: "IoE-TCP", 52: "USB", 53: "Bluetooth", 1000: "Custom",
};

// The values seen on a live PT, as opposed to read from the reference.
export const MEASURED_TRAFFIC_TYPES = new Set([0, 5, 11, 12]);

// Precedence order when deriving ONE state per frame. Whatever blocks goes first:
// a dropped frame matters more than a "sent" one in the same tick.
const _STATUS_ORDER = [
    ["dropped", "dropped"],
    ["collided_on_link", "collided_on_link"],
    ["collided_at_device", "collided_at_device"],
    ["not_forwarded", "not_forwarded"],
    ["unexpected", "unexpected"],
    ["buffered", "buffered"],
    ["in_transit", "in_transit"],
    ["accepted", "accepted"],
    ["sent", "sent"],
];

// States meaning "this packet did not reach its destination".
export const FAILURE_STATUSES = new Set([
    "dropped", "collided_on_link", "collided_at_device",
    "not_forwarded", "unexpected",
]);

// Drops that are part of normal operation, by PT's own decision text (PT 9.0.1): a
// flooded frame reaching a device it was not meant for, and a frame nobody on that
// device listens to (an STP BPDU reaching a router or a PC). Counting them as failures
// made a 100% ping read as "did not reach their destination".
export const EXPECTED_DROP_REASONS = [
    "destination MAC address does not match the receiving port's MAC address",
    "does not have a service that accepts this frame",
];

// Normal only when the destination is multicast (an OSPF hello at 224.0.0.5 reaching a
// PC); the same text for a unicast destination is a real addressing problem.
const _MULTICAST_DROP_REASON = "destination IP is not the broadcast address and it does not match the port's IP address";

function _is_expected_drop(reason, destination) {
    if (EXPECTED_DROP_REASONS.some((r) => reason.includes(r))) {
        return true;
    }
    if (reason.includes(_MULTICAST_DROP_REASON)) {
        try {
            return !!ip_address(destination).is_multicast;
        } catch {
            return false;
        }
    }
    return false;
}

export function traffic_type_label(raw) {
    /** Label for the traffic type; passes the raw value through if it is not in the enum. */
    // Python dict keys are ints: only a numeric raw can hit (a string "0" misses).
    if (typeof raw === "number" && Object.prototype.hasOwnProperty.call(TRAFFIC_TYPES, raw)) {
        return TRAFFIC_TYPES[raw];
    }
    return `type${pyStr(raw === undefined ? null : raw)}`;
}

// Python dict.pop(key, None).
function _popd(obj, key) {
    const v = obj[key] !== undefined ? obj[key] : null;
    delete obj[key];
    return v;
}
// Python dict.get(key, default): default only when the key is absent.
function _getd(obj, key, def) {
    return obj[key] !== undefined ? obj[key] : def;
}

export function normalize_frame(frame) {
    /** Labels the traffic type and fills empty endpoints from the user PDU, in place.
     *
     * getSourceString()/getDestinationString() came back empty on the ICMP frames of a
     * PDU fired with addSimplePdu. When the frame carries its PDU's endpoints
     * (`pdu_source`/`pdu_destination`, device names from UserTraffic), they stand in
     * for the missing strings; `endpoints_from` says so, because a device name is
     * not the IP address those fields normally hold.
     */
    frame["traffic_type"] = traffic_type_label(_popd(frame, "traffic_type_raw"));
    const _src = _popd(frame, "pdu_source");
    const pdu_src = pyTruthy(_src) ? _src : "";
    const _dst = _popd(frame, "pdu_destination");
    const pdu_dst = pyTruthy(_dst) ? _dst : "";
    let filled = false;
    if (!pyTruthy(frame.source) && pyTruthy(pdu_src)) {
        frame["source"] = pdu_src;
        filled = true;
    }
    if (!pyTruthy(frame.destination) && pyTruthy(pdu_dst)) {
        frame["destination"] = pdu_dst;
        filled = true;
    }
    if (filled) {
        frame["endpoints_from"] = "pdu";
    }
    return frame;
}

export function frame_status(frame) {
    /** A single state per frame, derived from PT's boolean flags. */
    for (const [flag, status] of _STATUS_ORDER) {
        if (pyTruthy(frame[flag])) {
            return status;
        }
    }
    return "pending";
}

const _strKeyCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function _sortedDict(counts) {
    const out = {};
    for (const k of Object.keys(counts).sort(_strKeyCmp)) out[k] = counts[k];
    return out;
}

export function summarize_trace(frames) {
    /** Groups the event list and separates what failed from what did not. */
    const by_status = {};
    const by_device = {};
    const failures = [];
    const expected = [];

    for (const frame of frames) {
        const status = frame_status(frame);
        frame["status"] = status;
        by_status[status] = (by_status[status] ?? 0) + 1;

        const device = pyTruthy(frame.device) ? frame.device : "?";
        by_device[device] = (by_device[device] ?? 0) + 1;

        if (FAILURE_STATUSES.has(status)) {
            const decisions = pyTruthy(frame.decisions) ? frame.decisions : [{}];
            const last = decisions[decisions.length - 1] ?? {};
            const entry = {
                "device": device,
                "status": status,
                "destination": _getd(frame, "destination", ""),
                "traffic": _getd(frame, "traffic_type", ""),
                // The last decision is the one that explains the outcome.
                "reason": _getd(last, "description", ""),
            };
            if (_is_expected_drop(entry["reason"], entry["destination"])) {
                expected.push(entry);
            } else {
                failures.push(entry);
            }
        }
    }

    return {
        "frames": frames.length,
        "by_status": _sortedDict(by_status),
        "by_device": _sortedDict(by_device),
        "failures": failures,
        "expected_drops": expected,
        "clean": !failures.length,
    };
}

export function trace_report(data) {
    /** The event-list read (packet_trace_js's reply) as summary + trace for the model.
     *
     * Shared by pt_read_packet_trace and pt_send_pdu so both explain a trace the same way.
     */
    const frames = data.frames !== undefined ? data.frames : [];
    for (const frame of frames) {
        normalize_frame(frame);
    }

    const result = summarize_trace(frames);
    result["total_in_event_list"] = _getd(data, "total", 0);
    result["simulation_mode"] = _getd(data, "simulation_mode", false);
    result["trace"] = frames;

    if (!pyTruthy(data.simulation_mode)) {
        result["summary"] = (
            "PT is in Realtime mode: the event list does not keep packets. " +
            "Call pt_simulation_mode(on=True) and generate traffic."
        );
    } else if (!frames.length) {
        result["summary"] = (
            "Simulation mode is on but there are no frames. Generate traffic " +
            "(for example pt_verify_connectivity) and read again."
        );
    } else if (result["clean"]) {
        const normal = result["expected_drops"].length;
        result["summary"] = (
            `${result["frames"]} frame(s) read, none failed.` +
            (normal ? ` ${normal} dropped as normal operation (flooded frames, STP BPDUs, multicast at hosts).` : "")
        );
    } else {
        const reasons = result["failures"].slice(0, 3)
            .filter((f) => pyTruthy(f["reason"])).map((f) => f["reason"]).join("; ");
        result["summary"] = (
            `⚠ ${result["failures"].length} frame(s) did not reach their destination. ${reasons}`
        );
    }
    return result;
}
