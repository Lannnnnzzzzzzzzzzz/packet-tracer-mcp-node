// Packet Tracer device catalog. (Port of infrastructure/catalog/devices.py)
//
// Ports verified against PT 8.x live — we do NOT include Vlan1
// because it is not used for physical cabling (it is an SVI).

import { PortSpeed } from "../../shared/enums.js";
import { MODEL_ALIASES } from "./aliases.js";


export class PortSpec {
    /** Specification of a physical port. */
    // Python: @dataclass(frozen=True) with fields (speed, slot, full_name="").
    // Accepts either the Python positional form new PortSpec(speed, slot, full_name)
    // or an object: new PortSpec({speed, slot, full_name}).
    constructor(speed, slot, full_name = "") {
        if (speed !== null && typeof speed === "object") {
            const obj = speed;
            this.speed = obj.speed;
            this.slot = obj.slot;
            this.full_name = obj.full_name !== undefined ? obj.full_name : "";
        } else {
            this.speed = speed;
            this.slot = slot;
            this.full_name = full_name;
        }
        // __post_init__
        if (!this.full_name) {
            const speed_str = (this.speed !== null && typeof this.speed === "object" && "value" in this.speed)
                ? this.speed.value : this.speed;
            this.full_name = `${speed_str}${this.slot}`;
        }
    }

    toDict() {
        return { speed: this.speed, slot: this.slot, full_name: this.full_name };
    }
}


export class DeviceModel {
    /** Packet Tracer device model. */
    // Python: @dataclass(frozen=True) with fields
    // (pt_type, category, ports, display_name="").
    // Accepts either the Python positional form
    // new DeviceModel(pt_type, category, ports, display_name)
    // or an object: new DeviceModel({pt_type, category, ports, display_name}).
    constructor(pt_type, category, ports, display_name = "") {
        if (pt_type !== null && typeof pt_type === "object") {
            const obj = pt_type;
            this.pt_type = obj.pt_type;
            this.category = obj.category;
            this.ports = obj.ports !== undefined ? obj.ports : [];
            this.display_name = obj.display_name !== undefined ? obj.display_name : "";
        } else {
            this.pt_type = pt_type;
            this.category = category;
            this.ports = ports;
            this.display_name = display_name;
        }
    }

    toDict() {
        return {
            pt_type: this.pt_type,
            category: this.category,
            ports: this.ports.map((p) => (p instanceof PortSpec ? p.toDict() : p)),
            display_name: this.display_name,
        };
    }
}


function _gig(slot) {
    return new PortSpec({ speed: PortSpeed.GIGABIT_ETHERNET, slot });
}

function _fast(slot) {
    return new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot });
}

function _serial(slot) {
    return new PortSpec({ speed: PortSpeed.SERIAL, slot });
}

function _eth(slot) {
    return new PortSpec({ speed: PortSpeed.ETHERNET, slot });
}

function _modem(slot) {
    return new PortSpec({ speed: PortSpeed.MODEM, slot });
}

function _coax(slot) {
    return new PortSpec({ speed: PortSpeed.COAXIAL, slot });
}


// =====================================================================
// ROUTERS (verified — no serial ports without HWIC modules)
// =====================================================================
export const ROUTER_1841 = new DeviceModel({
    pt_type: "1841", category: "router", display_name: "Cisco 1841",
    ports: [_fast("0/0"), _fast("0/1")],
});
export const ROUTER_1941 = new DeviceModel({
    pt_type: "1941", category: "router", display_name: "Cisco 1941",
    ports: [_gig("0/0"), _gig("0/1")],
});
export const ROUTER_2620XM = new DeviceModel({
    pt_type: "2620XM", category: "router", display_name: "Cisco 2620XM",
    ports: [_fast("0/0")],
});
export const ROUTER_2621XM = new DeviceModel({
    pt_type: "2621XM", category: "router", display_name: "Cisco 2621XM",
    ports: [_fast("0/0"), _fast("0/1")],
});
export const ROUTER_2811 = new DeviceModel({
    pt_type: "2811", category: "router", display_name: "Cisco 2811",
    ports: [_fast("0/0"), _fast("0/1")],
});
export const ROUTER_2901 = new DeviceModel({
    pt_type: "2901", category: "router", display_name: "Cisco 2901",
    ports: [_gig("0/0"), _gig("0/1")],
});
export const ROUTER_2911 = new DeviceModel({
    pt_type: "2911", category: "router", display_name: "Cisco 2911",
    ports: [_gig("0/0"), _gig("0/1"), _gig("0/2")],
});
export const ROUTER_819HG_4G = new DeviceModel({
    pt_type: "819HG-4G-IOX", category: "router", display_name: "Cisco 819HG-4G-IOX",
    ports: [_gig("0"), _fast("0")],
});
export const ROUTER_819HGW = new DeviceModel({
    pt_type: "819HGW", category: "router", display_name: "Cisco 819HGW",
    ports: [_gig("0"), _fast("0")],
});
export const ROUTER_829 = new DeviceModel({
    pt_type: "829", category: "router", display_name: "Cisco 829",
    ports: [_gig("0"), _gig("1")],
});
export const ROUTER_CGR1240 = new DeviceModel({
    pt_type: "CGR1240", category: "router", display_name: "Cisco CGR1240",
    ports: [_gig("0/0"), _gig("0/1")],
});
export const ROUTER_4321 = new DeviceModel({
    pt_type: "ISR4321", category: "router", display_name: "Cisco ISR 4321",
    ports: [_gig("0/0/0"), _gig("0/0/1")],
});
export const ROUTER_4331 = new DeviceModel({
    pt_type: "ISR4331", category: "router", display_name: "Cisco ISR 4331",
    ports: [_gig("0/0/0"), _gig("0/0/1"), _gig("0/0/2")],
});
export const ROUTER_PT = new DeviceModel({
    pt_type: "Router-PT", category: "router", display_name: "Generic Router",
    ports: [_fast("0/0"), _fast("0/1")],
});
export const ROUTER_PT_EMPTY = new DeviceModel({
    pt_type: "Router-PT-Empty", category: "router", display_name: "Generic Router (Empty)",
    ports: [],
});

// =====================================================================
// SWITCHES L2
// =====================================================================
function _switch_2950_ports() {
    return Array.from({ length: 24 }, (_, k) => _fast(`0/${k + 1}`));
}

function _switch_2950T_ports() {
    const fast = Array.from({ length: 24 }, (_, k) => _fast(`0/${k + 1}`));
    const gig = [_gig("0/1"), _gig("0/2")];
    return [...fast, ...gig];
}

function _switch_2960_ports() {
    const fast = Array.from({ length: 24 }, (_, k) => _fast(`0/${k + 1}`));
    const gig = [_gig("0/1"), _gig("0/2")];
    return [...fast, ...gig];
}

export const SWITCH_2950 = new DeviceModel({
    pt_type: "2950-24", category: "switch", display_name: "Cisco 2950-24",
    ports: _switch_2950_ports(),
});
export const SWITCH_2950T = new DeviceModel({
    pt_type: "2950T-24", category: "switch", display_name: "Cisco 2950T-24",
    ports: _switch_2950T_ports(),
});
export const SWITCH_2960 = new DeviceModel({
    pt_type: "2960-24TT", category: "switch", display_name: "Cisco 2960-24TT",
    ports: _switch_2960_ports(),
});
export const SWITCH_PT = new DeviceModel({
    pt_type: "Switch-PT", category: "switch", display_name: "Generic Switch",
    ports: Array.from({ length: 8 }, (_, k) => _fast(`0/${k + 1}`)),
});
export const SWITCH_PT_EMPTY = new DeviceModel({
    pt_type: "Switch-PT-Empty", category: "switch", display_name: "Generic Switch (Empty)",
    ports: [],
});

// =====================================================================
// SWITCHES L3
// =====================================================================
function _switch_3560_ports() {
    const fast = Array.from({ length: 24 }, (_, k) => _fast(`0/${k + 1}`));
    const gig = [_gig("0/1"), _gig("0/2")];
    return [...fast, ...gig];
}

function _switch_3650_ports() {
    // Measured in a PT 9.0.1 save: 24 copper Gigabit ports in stack member 1, then the
    // four SFP uplinks of C3650-SFP-BUILTIN. The SFP ports exist without a transceiver;
    // a copper cable on them needs a GLC-T. No FastEthernet at all.
    const copper = Array.from({ length: 24 }, (_, k) => _gig(`1/0/${k + 1}`));
    const sfp = Array.from({ length: 4 }, (_, k) => _gig(`1/1/${k + 1}`));
    return [...copper, ...sfp];
}

export const SWITCH_3560 = new DeviceModel({
    pt_type: "3560-24PS", category: "switch", display_name: "Cisco 3560-24PS",
    ports: _switch_3560_ports(),
});
export const SWITCH_3650 = new DeviceModel({
    pt_type: "3650-24PS", category: "switch", display_name: "Cisco 3650-24PS",
    ports: _switch_3650_ports(),
});
export const SWITCH_IE2000 = new DeviceModel({
    pt_type: "IE-2000", category: "switch", display_name: "Cisco IE-2000",
    ports: [...Array.from({ length: 8 }, (_, k) => _fast(`0/${k + 1}`)), _gig("0/1"), _gig("0/2")],
});

// =====================================================================
// END DEVICES (verified)
// =====================================================================
export const PC_PT = new DeviceModel({ pt_type: "PC-PT", category: "pc", display_name: "PC", ports: [_fast("0")] });
export const SERVER_PT = new DeviceModel({ pt_type: "Server-PT", category: "server", display_name: "Server", ports: [_fast("0")] });
export const LAPTOP_PT = new DeviceModel({ pt_type: "Laptop-PT", category: "laptop", display_name: "Laptop", ports: [_fast("0")] });
export const TABLET_PT = new DeviceModel({ pt_type: "TabletPC-PT", category: "pc", display_name: "Tablet PC", ports: [_fast("0")] });
export const SMARTPHONE_PT = new DeviceModel({ pt_type: "SMARTPHONE-PT", category: "pc", display_name: "Smartphone", ports: [_fast("0")] });
export const PRINTER_PT = new DeviceModel({ pt_type: "Printer-PT", category: "pc", display_name: "Printer", ports: [_fast("0")] });
export const WIRELESS_END_DEVICE_PT = new DeviceModel({
    pt_type: "WirelessEndDevice-PT", category: "wireless_end_device",
    display_name: "Wireless End Device", ports: [],
});
export const WIRED_END_DEVICE_PT = new DeviceModel({
    pt_type: "WiredEndDevice-PT", category: "wired_end_device",
    display_name: "Wired End Device", ports: [_fast("0")],
});
export const TV_PT = new DeviceModel({ pt_type: "TV-PT", category: "tv", display_name: "TV", ports: [_fast("0")] });
export const HOME_VOIP_PT = new DeviceModel({
    pt_type: "Home-VoIP-PT", category: "voip", display_name: "Home VoIP Phone",
    ports: [_fast("0")],
});
export const ANALOG_PHONE_PT = new DeviceModel({
    pt_type: "Analog-Phone-PT", category: "analog_phone", display_name: "Analog Phone",
    ports: [new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Phone0" })],
});
export const EMBEDDED_SERVER_PT = new DeviceModel({
    pt_type: "Embedded-Server-PT", category: "embedded_server",
    display_name: "Embedded Server", ports: [_fast("0")],
});

// =====================================================================
// CLOUD / WAN
//
// The eight ports come from reading `getPorts()` on a live Cloud-PT in PT 9.0.1:
//   Serial0, Serial1, Serial2, Serial3, Modem4, Modem5, Ethernet6, Coaxial7
//
// The catalog declared ONLY Ethernet6, so `pt_add_link` and `validate_plan`
// rejected the other seven -- ports the device does have -- before the request
// reached PT.
//
// Ethernet6 was also declared as FastEthernet with the name forced by hand; it
// worked through the override, not through the speed. With the real speed the
// name is derived on its own, which is how the other models work.
// =====================================================================
export const CLOUD_PT = new DeviceModel({
    pt_type: "Cloud-PT", category: "cloud", display_name: "Cloud",
    ports: [
        _serial("0"), _serial("1"), _serial("2"), _serial("3"),
        _modem("4"), _modem("5"),
        _eth("6"),
        _coax("7"),
    ],
});
export const CLOUD_PT_EMPTY = new DeviceModel({
    pt_type: "Cloud-PT-Empty", category: "cloud", display_name: "Cloud (Empty)",
    ports: [],
});

// =====================================================================
// ACCESS POINTS (verified: Port 0)
// =====================================================================
export const AP_PT = new DeviceModel({
    pt_type: "AccessPoint-PT", category: "accesspoint", display_name: "Access Point",
    ports: [new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Port 0" })],
});
export const AP_PT_A = new DeviceModel({
    pt_type: "AccessPoint-PT-A", category: "accesspoint", display_name: "Access Point-A",
    ports: [new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Port 0" })],
});
export const AP_PT_N = new DeviceModel({
    pt_type: "AccessPoint-PT-N", category: "accesspoint", display_name: "Access Point-N",
    ports: [new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Port 0" })],
});
export const AP_PT_AC = new DeviceModel({
    pt_type: "AccessPoint-PT-AC", category: "accesspoint", display_name: "Access Point-AC",
    ports: [new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Port 0" })],
});
export const LAP_PT = new DeviceModel({
    pt_type: "LAP-PT", category: "accesspoint", display_name: "Lightweight AP",
    ports: [new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Port 0" })],
});
export const AP_3702I = new DeviceModel({
    pt_type: "3702i", category: "accesspoint", display_name: "Cisco 3702i AP",
    ports: [new PortSpec({ speed: PortSpeed.GIGABIT_ETHERNET, slot: "0", full_name: "GigabitEthernet0" })],
});

// =====================================================================
// HUB
// =====================================================================
export const HUB_PT = new DeviceModel({
    pt_type: "Hub-PT", category: "hub", display_name: "Hub",
    ports: Array.from({ length: 8 }, (_, i) => new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: String(i), full_name: `Port ${i}` })),
});

// =====================================================================
// BRIDGE
// =====================================================================
export const BRIDGE_PT = new DeviceModel({
    pt_type: "Bridge-PT", category: "bridge", display_name: "Bridge",
    ports: [
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Port 0" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "1", full_name: "Port 1" }),
    ],
});

// =====================================================================
// REPEATER
// =====================================================================
export const REPEATER_PT = new DeviceModel({
    pt_type: "Repeater-PT", category: "repeater", display_name: "Repeater",
    ports: [
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Port 0" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "1", full_name: "Port 1" }),
    ],
});

// =====================================================================
// COAXIAL SPLITTER
// =====================================================================
export const COAXIAL_SPLITTER_PT = new DeviceModel({
    pt_type: "CoAxialSplitter-PT", category: "splitter", display_name: "Coaxial Splitter",
    ports: Array.from({ length: 4 }, (_, i) => new PortSpec({ speed: PortSpeed.COAXIAL, slot: String(i), full_name: `Coaxial${i}` })),
});

// =====================================================================
// FIREWALLS (Cisco ASA)
// =====================================================================
export const ASA_5505 = new DeviceModel({
    pt_type: "5505", category: "firewall", display_name: "Cisco ASA 5505",
    ports: Array.from({ length: 8 }, (_, i) => _fast(`0/${i}`)),
});
export const ASA_5506 = new DeviceModel({
    pt_type: "5506-X", category: "firewall", display_name: "Cisco ASA 5506-X",
    ports: Array.from({ length: 8 }, (_, i) => _gig(`1/${i}`)),
});

// =====================================================================
// WIRELESS LAN CONTROLLER
// =====================================================================
export const WLC_PT = new DeviceModel({
    pt_type: "WLC-PT", category: "wlc", display_name: "Wireless LAN Controller",
    ports: Array.from({ length: 8 }, (_, k) => _gig(String(k + 1))),
});
export const WLC_2504 = new DeviceModel({
    pt_type: "WLC-2504", category: "wlc", display_name: "Cisco WLC 2504",
    ports: Array.from({ length: 4 }, (_, k) => _gig(String(k + 1))),
});
export const WLC_3504 = new DeviceModel({
    pt_type: "WLC-3504", category: "wlc", display_name: "Cisco WLC 3504",
    ports: Array.from({ length: 4 }, (_, k) => _gig(String(k + 1))),
});

// =====================================================================
// DSL / CABLE MODEMS
// =====================================================================
export const DSL_MODEM_PT = new DeviceModel({
    pt_type: "DSL-Modem-PT", category: "modem", display_name: "DSL Modem",
    ports: [
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Ethernet0" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "1", full_name: "Coaxial0" }),
    ],
});
export const CABLE_MODEM_PT = new DeviceModel({
    pt_type: "Cable-Modem-PT", category: "modem", display_name: "Cable Modem",
    ports: [
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Ethernet0" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "1", full_name: "Coaxial0" }),
    ],
});

// =====================================================================
// WIRELESS / HOME ROUTERS
// =====================================================================
export const LINKSYS_WRT300N = new DeviceModel({
    pt_type: "Linksys-WRT300N", category: "wireless_router",
    display_name: "Linksys WRT300N",
    ports: [
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Internet" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "1", full_name: "Ethernet 1" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "2", full_name: "Ethernet 2" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "3", full_name: "Ethernet 3" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "4", full_name: "Ethernet 4" }),
    ],
});
export const HOME_ROUTER_PT_AC = new DeviceModel({
    pt_type: "HomeRouter-PT-AC", category: "home_gateway",
    display_name: "Home Router AC",
    ports: [
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Internet" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "1", full_name: "Ethernet 1" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "2", full_name: "Ethernet 2" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "3", full_name: "Ethernet 3" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "4", full_name: "Ethernet 4" }),
    ],
});

// =====================================================================
// IP PHONE
// =====================================================================
export const IP_PHONE_7960 = new DeviceModel({
    pt_type: "7960", category: "ip_phone", display_name: "Cisco IP Phone 7960",
    ports: [
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Port 0" }),
        new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "1", full_name: "PC Port" }),
    ],
});

// =====================================================================
// TELECOM / SPECIAL DEVICES
// =====================================================================
export const CELL_TOWER = new DeviceModel({
    pt_type: "Cell-Tower", category: "cell_tower", display_name: "Cell Tower",
    ports: [new PortSpec({ speed: PortSpeed.COAXIAL, slot: "0", full_name: "Coaxial0" })],
});
export const CENTRAL_OFFICE_SERVER = new DeviceModel({
    pt_type: "Central-Office-Server", category: "central_office",
    display_name: "Central Office Server",
    ports: [new PortSpec({ speed: PortSpeed.FAST_ETHERNET, slot: "0", full_name: "Ethernet0" })],
});
export const WIRELESS_BRIDGE_802 = new DeviceModel({
    pt_type: "802", category: "accesspoint", display_name: "Cisco 802",
    ports: [_fast("0")],
});
export const WIRELESS_BRIDGE_803 = new DeviceModel({
    pt_type: "803", category: "accesspoint", display_name: "Cisco 803",
    ports: [_fast("0")],
});
export const SNIFFER = new DeviceModel({
    pt_type: "Sniffer", category: "sniffer", display_name: "Sniffer",
    ports: [_fast("0")],
});

// =====================================================================
// MCU / SBC (Microcontroller / Single Board Computer)
// =====================================================================
export const MCU_PT = new DeviceModel({
    pt_type: "MCU-PT", category: "mcu", display_name: "Microcontroller (MCU)",
    ports: [],
});
export const SBC_PT = new DeviceModel({
    pt_type: "SBC-PT", category: "sbc", display_name: "Single Board Computer (SBC)",
    ports: [_fast("0")],
});

// =====================================================================
// DWDM / DLC
// =====================================================================
export const DLC100 = new DeviceModel({
    pt_type: "DLC100", category: "network_controller",
    display_name: "DWDM DLC-100",
    ports: [_fast("0")],
});

// =====================================================================
// MERAKI
// =====================================================================
export const MERAKI_MX65W = new DeviceModel({
    pt_type: "Meraki-MX65W", category: "meraki", display_name: "Meraki MX65W",
    ports: Array.from({ length: 12 }, (_, i) => _gig(String(i))),
});
export const MERAKI_SERVER = new DeviceModel({
    pt_type: "Meraki-Server", category: "meraki", display_name: "Meraki Server",
    ports: [_gig("0")],
});

// =====================================================================
// NETWORK CONTROLLER
// =====================================================================
export const NETWORK_CONTROLLER = new DeviceModel({
    pt_type: "NetworkController", category: "network_controller",
    display_name: "Network Controller",
    ports: [_gig("0")],
});

// =====================================================================
// INFRASTRUCTURE (Patch Panels, Wall Mounts, Power)
// =====================================================================
export const POWER_DISTRIBUTION = new DeviceModel({
    pt_type: "Power Distribution Device", category: "power_dist",
    display_name: "Power Distribution Device", ports: [],
});
export const COPPER_PATCH_PANEL = new DeviceModel({
    pt_type: "Copper Patch Panel", category: "patch_panel",
    display_name: "Copper Patch Panel",
    ports: Array.from({ length: 24 }, (_, i) => _fast(String(i))),
});
export const FIBER_PATCH_PANEL = new DeviceModel({
    pt_type: "Fiber Patch Panel", category: "patch_panel",
    display_name: "Fiber Patch Panel",
    ports: Array.from({ length: 24 }, (_, i) => new PortSpec({ speed: PortSpeed.GIGABIT_ETHERNET, slot: String(i), full_name: `Fiber${i}` })),
});
export const COPPER_WALL_MOUNT = new DeviceModel({
    pt_type: "Copper Wall Mount", category: "wall_mount",
    display_name: "Copper Wall Mount",
    ports: [_fast("0"), _fast("1")],
});
export const FIBER_WALL_MOUNT = new DeviceModel({
    pt_type: "Fiber Wall Mount", category: "wall_mount",
    display_name: "Fiber Wall Mount",
    ports: [
        new PortSpec({ speed: PortSpeed.GIGABIT_ETHERNET, slot: "0", full_name: "Fiber0" }),
        new PortSpec({ speed: PortSpeed.GIGABIT_ETHERNET, slot: "1", full_name: "Fiber1" }),
    ],
});

// =====================================================================
// IOT (generic — represents all ~80 IoT Type 39 devices)
// =====================================================================
export const THING_PT = new DeviceModel({
    pt_type: "Thing", category: "iot", display_name: "IoT Thing",
    ports: [],
});


// =====================================================================
// INDEXED CATALOG
// =====================================================================
export const ALL_MODELS = (() => {
    const out = {};
    for (const m of [
        // Routers
        ROUTER_1841, ROUTER_1941, ROUTER_2620XM, ROUTER_2621XM,
        ROUTER_2811, ROUTER_2901, ROUTER_2911,
        ROUTER_819HG_4G, ROUTER_819HGW, ROUTER_829, ROUTER_CGR1240,
        ROUTER_4321, ROUTER_4331, ROUTER_PT, ROUTER_PT_EMPTY,
        // Switches L2
        SWITCH_2950, SWITCH_2950T, SWITCH_2960, SWITCH_PT, SWITCH_PT_EMPTY,
        // Switches L3
        SWITCH_3560, SWITCH_3650, SWITCH_IE2000,
        // End devices
        PC_PT, SERVER_PT, LAPTOP_PT, TABLET_PT, SMARTPHONE_PT, PRINTER_PT,
        WIRELESS_END_DEVICE_PT, WIRED_END_DEVICE_PT,
        TV_PT, HOME_VOIP_PT, ANALOG_PHONE_PT, EMBEDDED_SERVER_PT,
        // Cloud / WAN
        CLOUD_PT, CLOUD_PT_EMPTY,
        // Access Points
        AP_PT, AP_PT_A, AP_PT_N, AP_PT_AC, LAP_PT, AP_3702I,
        // Hub / Bridge / Repeater / Splitter
        HUB_PT, BRIDGE_PT, REPEATER_PT, COAXIAL_SPLITTER_PT,
        // Firewalls
        ASA_5505, ASA_5506,
        // WLC
        WLC_PT, WLC_2504, WLC_3504,
        // Modems
        DSL_MODEM_PT, CABLE_MODEM_PT,
        // Wireless / Home Routers
        LINKSYS_WRT300N, HOME_ROUTER_PT_AC,
        // IP Phone
        IP_PHONE_7960,
        // Telecom / Special
        CELL_TOWER, CENTRAL_OFFICE_SERVER,
        WIRELESS_BRIDGE_802, WIRELESS_BRIDGE_803,
        SNIFFER,
        // MCU / SBC
        MCU_PT, SBC_PT,
        // DWDM
        DLC100,
        // Meraki
        MERAKI_MX65W, MERAKI_SERVER,
        // Network Controller
        NETWORK_CONTROLLER,
        // Infrastructure
        POWER_DISTRIBUTION, COPPER_PATCH_PANEL, FIBER_PATCH_PANEL,
        COPPER_WALL_MOUNT, FIBER_WALL_MOUNT,
        // IoT
        THING_PT,
    ]) {
        out[m.pt_type] = m;
    }
    return out;
})();


export function resolve_model(name) {
    /** Resolves a name/alias to a DeviceModel. */
    const key = Object.prototype.hasOwnProperty.call(MODEL_ALIASES, name.toLowerCase())
        ? MODEL_ALIASES[name.toLowerCase()] : name;
    return Object.prototype.hasOwnProperty.call(ALL_MODELS, key) ? ALL_MODELS[key] : null;
}


export function get_ports_by_speed(model, speed) {
    /** Returns the ports of a model filtered by speed. */
    return model.ports.filter((p) => p.speed === speed);
}


export function get_valid_ports(model_name) {
    /** Returns the set of valid port names for a model. */
    const model = resolve_model(model_name);
    if (!model) {
        return new Set();
    }
    return new Set(model.ports.map((p) => p.full_name));
}


export function category_of_model(model_name) {
    /** Catalog category for a model. Empty string if it is not known.
     *
     * It exists to translate what PT returns from `getModel()` into the key that
     * the cabling rules use. Do NOT use `getClassName()` for this: PT classifies by
     * behavior, not by network role, so a 3560 (multilayer switch) answers "Router"
     * and a 2960 answers "CiscoDevice" — with that, the "switch" category never
     * appeared and every router<->switch link was cabled as a crossover.
     */
    const model = resolve_model(model_name);
    return model ? model.category : "";
}

// Python dict insertion order of ALL_MODELS. JS objects iterate
// integer-like keys ("802", "1841", ...) numerically first, so any
// consumer that must reproduce the Python iteration order uses this.
export const ALL_MODELS_ORDER = ["1841", "1941", "2620XM", "2621XM", "2811", "2901", "2911", "819HG-4G-IOX", "819HGW", "829", "CGR1240", "ISR4321", "ISR4331", "Router-PT", "Router-PT-Empty", "2950-24", "2950T-24", "2960-24TT", "Switch-PT", "Switch-PT-Empty", "3560-24PS", "3650-24PS", "IE-2000", "PC-PT", "Server-PT", "Laptop-PT", "TabletPC-PT", "SMARTPHONE-PT", "Printer-PT", "WirelessEndDevice-PT", "WiredEndDevice-PT", "TV-PT", "Home-VoIP-PT", "Analog-Phone-PT", "Embedded-Server-PT", "Cloud-PT", "Cloud-PT-Empty", "AccessPoint-PT", "AccessPoint-PT-A", "AccessPoint-PT-N", "AccessPoint-PT-AC", "LAP-PT", "3702i", "Hub-PT", "Bridge-PT", "Repeater-PT", "CoAxialSplitter-PT", "5505", "5506-X", "WLC-PT", "WLC-2504", "WLC-3504", "DSL-Modem-PT", "Cable-Modem-PT", "Linksys-WRT300N", "HomeRouter-PT-AC", "7960", "Cell-Tower", "Central-Office-Server", "802", "803", "Sniffer", "MCU-PT", "SBC-PT", "DLC100", "Meraki-MX65W", "Meraki-Server", "NetworkController", "Power Distribution Device", "Copper Patch Panel", "Fiber Patch Panel", "Copper Wall Mount", "Fiber Wall Mount", "Thing"];
