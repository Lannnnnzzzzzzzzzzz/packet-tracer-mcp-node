// Shared enumerations. (Port of shared/enums.py)
//
// Python uses `class X(str, Enum)`: members ARE their string values. In JS the
// enums are frozen maps from member name to the same string value, so
// `RoutingProtocol.OSPF === "ospf"` behaves like the Python comparison.

export const RoutingProtocol = Object.freeze({
    STATIC: "static",
    OSPF: "ospf",
    EIGRP: "eigrp",
    RIP: "rip",
    NONE: "none",
});

export const TopologyTemplate = Object.freeze({
    SINGLE_LAN: "single_lan",
    MULTI_LAN: "multi_lan",
    MULTI_LAN_WAN: "multi_lan_wan",
    STAR: "star",
    HUB_SPOKE: "hub_spoke",
    BRANCH_OFFICE: "branch_office",
    ROUTER_ON_A_STICK: "router_on_a_stick",
    THREE_ROUTER_TRIANGLE: "three_router_triangle",
    CUSTOM: "custom",
});

export const DeviceCategory = Object.freeze({
    ROUTER: "router",
    SWITCH: "switch",
    PC: "pc",
    SERVER: "server",
    LAPTOP: "laptop",
    CLOUD: "cloud",
    ACCESS_POINT: "accesspoint",
    HUB: "hub",
    FIREWALL: "firewall",
    WLC: "wlc",
    MODEM: "modem",
    BRIDGE: "bridge",
    REPEATER: "repeater",
    SPLITTER: "splitter",
    WIRELESS_ROUTER: "wireless_router",
    HOME_GATEWAY: "home_gateway",
    IP_PHONE: "ip_phone",
    TV: "tv",
    VOIP: "voip",
    ANALOG_PHONE: "analog_phone",
    SNIFFER: "sniffer",
    IOT: "iot",
    MCU: "mcu",
    SBC: "sbc",
    PATCH_PANEL: "patch_panel",
    WALL_MOUNT: "wall_mount",
    POWER_DIST: "power_dist",
    CELL_TOWER: "cell_tower",
    CENTRAL_OFFICE: "central_office",
    MERAKI: "meraki",
    NETWORK_CONTROLLER: "network_controller",
    WIRELESS_END_DEVICE: "wireless_end_device",
    WIRED_END_DEVICE: "wired_end_device",
    EMBEDDED_SERVER: "embedded_server",
});

export const DeviceRole = Object.freeze({
    /** Semantic role of the device in the topology. */
    CORE_ROUTER: "core_router",
    BRANCH_ROUTER: "branch_router",
    EDGE_ROUTER: "edge_router",
    WAN_CLOUD: "wan_cloud",
    ACCESS_SWITCH: "access_switch",
    DISTRIBUTION_SWITCH: "distribution_switch",
    END_HOST: "end_host",
    SERVER_HOST: "server_host",
});

export const CableType = Object.freeze({
    STRAIGHT: "straight",
    CROSS: "cross",
    SERIAL: "serial",
    FIBER: "fiber",
    CONSOLE: "console",
    PHONE: "phone",
    COAXIAL: "coaxial",
    AUTO: "auto",
    ROLL: "roll",
    CABLE: "cable",
    WIRELESS: "wireless",
    OCTAL: "octal",
    CELLULAR: "cellular",
    USB: "usb",
    CUSTOM_IO: "custom_io",
});

export const PortSpeed = Object.freeze({
    FAST_ETHERNET: "FastEthernet",
    GIGABIT_ETHERNET: "GigabitEthernet",
    SERIAL: "Serial",
    CONSOLE: "Console",
    ETHERNET: "Ethernet",
    COAXIAL: "Coaxial",
    MODEM: "Modem",
    USB: "USB",
    WIRELESS: "Wireless",
});

/** Look up an enum member by value (Python `Enum(value)`); undefined if absent. */
export function enumByValue(enumObj, value) {
    for (const key of Object.keys(enumObj)) {
        if (enumObj[key] === value) return enumObj[key];
    }
    return undefined;
}
