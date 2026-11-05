// Names of the tabs and apps in a device's dialog.
// (Port of infrastructure/ui/names.py)
//
// The Desktop buttons' objectNames come from the documentation of
// `DeviceDialog::setWidgetVisible` (PT 9.0.1's help/default/IpcAPI) and were
// verified through UI Automation against a real PC-PT: each button's
// AutomationId ends in that objectName (e.g. `...CommandPromptBtn`).
// "MIBBroswerBtn" keeps Cisco's typo on purpose.

// normalised alias → objectName of the Desktop button
export const DESKTOP_APPS = {
    "ipconfiguration": "IPConfigBtn", "ipconfig": "IPConfigBtn",
    "dialup": "DialupBtn",
    "terminal": "TerminalBtn",
    "commandprompt": "CommandPromptBtn", "cmd": "CommandPromptBtn", "prompt": "CommandPromptBtn",
    "webbrowser": "WebBrowserBtn", "browser": "WebBrowserBtn", "web": "WebBrowserBtn",
    "pcwireless": "PCWirelessBtn", "wireless": "PCWirelessBtn",
    "vpn": "VPNBtn",
    "trafficgenerator": "TrafficGeneratorBtn",
    "mibbrowser": "MIBBroswerBtn",
    "ciscoipcommunicator": "IPCommunicatorBtn", "ipcommunicator": "IPCommunicatorBtn",
    "email": "EmailBtn", "mail": "EmailBtn", "mailbrowser": "EmailBtn",
    "pppoedialer": "PPPoEDialerBtn", "pppoe": "PPPoEDialerBtn",
    "texteditor": "TextEditorBtn", "editor": "TextEditorBtn",
    "firewall": "FirewallBtn", "ipv4firewall": "FirewallBtn",
    "ipv6firewall": "IPv6FirewallBtn",
    "aaaaccounting": "AAAAccountingBtn",
    "netflowcollector": "NetflowCollectorBtn",
    "ioxide": "IoXSdkBtn", "ioxsdk": "IoXSdkBtn",
    "tftpservice": "TftpBtn", "tftp": "TftpBtn",
    "sshclient": "SshClientBtn", "ssh": "SshClientBtn",
    "bluetooth": "BluetoothBtn",
    "iotmonitor": "IoT Monitor_btn",
    "iotide": "IoT IDE_btn",
    "userappsmanager": "User Apps Manager_btn",
    "supervisoryworkstation": "Supervisory Workstation_btn",
};

// Known tabs (the visible name). Each device type shows a subset:
// PC = Physical/Config/Desktop/Programming/Attributes, router =
// Physical/Config/CLI/Attributes, Server-PT adds Services.
export const TABS = ["Physical", "Config", "CLI", "Desktop", "Services", "GUI", "Programming", "Attributes"];

export function normalize(name) {
    return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function desktop_app_object_name(app) {
    /** objectName of the button for an app ('Command Prompt', 'cmd', 'web_browser'...). */
    const key = normalize(app);
    if (!key) {
        return null;
    }
    if (Object.prototype.hasOwnProperty.call(DESKTOP_APPS, key)) {
        return DESKTOP_APPS[key];
    }
    // The objectName itself is accepted too ("CommandPromptBtn").
    for (const obj of Object.values(DESKTOP_APPS)) {
        if (normalize(obj) === key) {
            return obj;
        }
    }
    return null;
}

export function known_apps() {
    return [...new Set(Object.keys(DESKTOP_APPS).filter((k) => k.length > 4))]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function tab_matches(wanted, visible_name) {
    return normalize(wanted) === normalize(visible_name);
}
