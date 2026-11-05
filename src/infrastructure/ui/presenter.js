// Presenter: shows a device's dialog in PT and captures it.
// (Port of infrastructure/ui/presenter.py)
//
// Order of preference, from most native to least (verified against PT 9.0.1):
//
// 1. If the dialog already exists (even hidden), it is shown with PT's API
//    (`DialogManager.getDialog(name).setVisible(true)`).
// 2. If it does not exist, PT offers no call to open it: a click is posted to
//    the device's icon on the canvas (`PostMessage`, the real cursor does not
//    move). The active tool must be "Select" first: with "Delete" active that
//    click would DELETE the device.
// 3. Tab, section (Config > FastEthernet0, Services > DHCP) and Desktop app are
//    chosen through UI Automation (SelectionItem / Invoke), no keyboard or mouse.
// 4. Capture is `PrintWindow`: it works even when the window is covered.
//
// Whatever touches the GUI runs inside `win32.keep_user_focus`: Qt activates the
// dialog it opens, and the user's keystrokes must not follow it into PT's console.
//
// JS port: `send_and_wait` is async, so the Presenter's methods are async, and
// Python's `with win32.keep_user_focus(...)` becomes
// `for await (const guard of win32.keep_user_focus(...)) { ... }`.

import fs from "node:fs";
import path from "node:path";

import * as names from "./names.js";
import { bgra_to_png, looks_blank } from "./png.js";
import * as win32 from "./win32.js";
import { Uia } from "./uia.js";
import { pyJsonDumps, monotonic, sleep as _sleep_ms } from "../../shared/pycompat.js";

// Python time.sleep takes seconds; pycompat's sleep takes milliseconds.
const _default_sleep = (seconds) => _sleep_ms(seconds * 1000);

export class PresenterError extends Error {
    constructor(message) {
        super(message);
        this.name = "PresenterError";
    }
}


// ---------------------------------------------------------------------------
// JS (module level: testable)
// ---------------------------------------------------------------------------

export function device_state_js(device) {
    const dev = pyJsonDumps(device);
    return (
        "(function(){var aw=ipc.appWindow();"
        + `var d=ipc.network().getDevice(${dev});`
        + "if(!d){reportResult(JSON.stringify({ok:false,error:'device_not_found'}));return;}"
        + "var lw=aw.getActiveWorkspace().getLogicalWorkspace();"
        + `var dlg=null;try{dlg=aw.getDialogManager().getDialog(${dev});}catch(e){}`
        + "reportResult(JSON.stringify({ok:true,pid:aw.getProcessId(),logical:!!aw.isLogicalMode(),"
        + "zoom:lw.getCurrentZoom(),cx:d.getCenterXCoordinate(),cy:d.getCenterYCoordinate(),"
        + "open:!!dlg,host:(typeof d.getCommandPrompt==='function'),model:String(d.getModel())}));"
        + "})();"
    );
}

export function show_dialog_js(device, visible) {
    const dev = pyJsonDumps(device);
    const flag = visible ? "true" : "false";
    return (
        "(function(){var dm=ipc.appWindow().getDialogManager();"
        + `var dlg=dm.getDialog(${dev});`
        + `if(dlg){dlg.setVisible(${flag});reportResult('ok');}else{reportResult('none');}`
        + "})();"
    );
}

export function close_all_js() {
    return "(function(){ipc.appWindow().getDialogManager().closeAll();reportResult('ok');})();";
}

export function center_on_js(device) {
    return (
        "(function(){ipc.appWindow().getActiveWorkspace().getLogicalWorkspace()"
        + `.centerOnComponentByName(${pyJsonDumps(device)});reportResult('ok');})();`
    );
}

export function pid_js() {
    return "(function(){reportResult(String(ipc.appWindow().getProcessId()));})();";
}


// Title bars of the Desktop apps. PT 9.0.1 uses two variants (seen through
// UIA): Command Prompt → m_titleBar.m_titleLabel / m_closeButton; Firewall and
// Email → m_titleFrame.m_titleLable (Cisco's typo) / m_closeBtn.
export const APPLET_TITLES = ["m_titleBar.m_titleLabel", "m_titleFrame.m_titleLable"];
export const APPLET_CLOSERS = ["m_titleBar.m_closeButton", "m_titleFrame.m_closeBtn"];

export function applet_parts(els, suffixes) {
    /** Visible elements of the open apps whose AutomationId ends in one of
     * `suffixes`. */
    return els.filter((e) => e.automation_id.includes("CDesktopApplet")
        && suffixes.some((s) => e.automation_id.endsWith(s)) && !e.offscreen);
}


// ---------------------------------------------------------------------------

export function is_available() {
    /** (available, reason). The GUI part needs Windows and comtypes. */
    if (!win32.is_supported()) {
        return [false, "presenting in PT's GUI only works on Windows"];
    }
    // Python checks `import comtypes` here. The Node port has no COM backend
    // (see uia.js), so it lands on the same "missing" answer.
    return [false, ("'comtypes' is missing. Installed with uvx: register the server as "
        + "`uvx --from \"packet-tracer-mcp[ui]\" packet-tracer-mcp --stdio` and restart "
        + "the agent. Installed with pip: `pip install packet-tracer-mcp[ui]`")];
}

export function zoom_restore_plan(zoom) {
    /** Toolbar button and number of presses that bring the canvas from 100% back to `zoom`. */
    if (zoom < 0) {
        return ["Zoom Out", -zoom];
    }
    if (zoom > 0) {
        return ["Zoom In", zoom];
    }
    return ["", 0];
}

export class Presenter {
    constructor(send_and_wait, { sleep = _default_sleep } = {}) {
        this._send = send_and_wait;
        this._sleep = sleep;
    }

    // -- plumbing ---------------------------------------------------------
    async _js(js, timeout = 10.0) {
        const raw = await this._send(js, timeout);
        if (raw === null || raw === undefined) {
            throw new PresenterError("No answer from PT (bridge timeout).");
        }
        if (raw.startsWith("PT_ERROR") || raw.startsWith("ERROR")) {
            throw new PresenterError(`PT answered with an error: ${raw}`);
        }
        return raw;
    }

    async _state(device) {
        const data = JSON.parse(await this._js(device_state_js(device)));
        if (!data["ok"]) {
            throw new PresenterError(`'${device}' does not exist in the active topology.`);
        }
        return data;
    }

    async _pid() {
        return Math.trunc(Number(await this._js(pid_js())));
    }

    async device_info(device) {
        /** pid, logical view, zoom, coordinates, whether it is a host and whether its dialog exists. */
        return this._state(device);
    }

    async _wait_window(pid, title, seconds) {
        const deadline = monotonic() + seconds;
        while (true) {
            const hwnd = win32.find_window(pid, title);
            if (hwnd || monotonic() >= deadline) {
                return hwnd;
            }
            await this._sleep(0.15);
        }
    }

    // -- open -------------------------------------------------------------
    async open(
        device,
        {
            tab = "",
            app = "",
            section = "",
            scroll_bottom = false,
            reopen = false,
        } = {},
    ) {
        /** Show the dialog on `tab`/`section`/`app`.
         *
         * `reopen`: if the app is already open, close it and open it again. State
         * panels (IP Configuration...) need this: they read their values when
         * opened and do NOT refresh if the API changes them afterwards. Consoles
         * do update live.
         */
        const [ok, why] = is_available();
        if (!ok) {
            throw new PresenterError(why);
        }

        const st = await this._state(device);
        const pid = Math.trunc(st["pid"]);
        let result;
        let guard;
        for await (const g of win32.keep_user_focus(pid)) {
            guard = g;
            result = await this._open(device, st, pid, {
                tab: tab, app: app, section: section,
                scroll_bottom: scroll_bottom, reopen: reopen,
            });
        }
        result["steps"].push(...guard.notes());
        return result;
    }

    async _open(device, st, pid, { tab, app, section, scroll_bottom, reopen }) {
        const steps = [];
        let hwnd = win32.find_window(pid, device);
        if (hwnd === null && st["open"]) {
            await this._js(show_dialog_js(device, true));
            hwnd = await this._wait_window(pid, device, 2.0);
            if (hwnd) {
                steps.push("dialog shown through PT's API");
            }
        }
        const u = new Uia();
        if (hwnd === null) {
            if (!st["logical"]) {
                throw new PresenterError(
                    "PT is in the Physical view; the dialog opens from the Logical view."
                );
            }
            hwnd = await this._open_by_click(u, pid, device, st, steps);
        } else {
            steps.push("dialog already open");
        }
        win32.raise_window(hwnd);

        if (app && !tab) {
            tab = "Desktop";
        }
        if (tab) {
            this._select_tab(u, hwnd, tab);
            steps.push(`tab ${tab}`);
            await this._sleep(0.25);
        }
        if (section) {
            this._open_section(u, hwnd, section);
            steps.push(`section ${section}`);
            await this._sleep(0.2);
        }
        if (app) {
            steps.push(await this._open_app(u, hwnd, app, { reopen: reopen }));
            await this._sleep(0.35);
        }
        if (scroll_bottom) {
            if (this.scroll_consoles(hwnd, u)) {
                steps.push("console scrolled to the end");
            }
        }
        return { "ok": true, "device": device, "hwnd": hwnd, "tab": tab, "app": app,
            "section": section, "steps": steps };
    }

    async _open_by_click(u, pid, device, st, steps) {
        const main = win32.main_window(pid);
        if (main === null) {
            throw new PresenterError("Can't find Packet Tracer's main window.");
        }
        const els = u.descendants(main);
        const select = els.find((e) => e.name.startsWith("Select (")) ?? null;
        if (select === null) {
            throw new PresenterError("Can't find PT's Select tool; not clicking blind.");
        }
        if (u.toggle_state(select) !== 1) {
            u.invoke(select);
            await this._sleep(0.1);
            if (u.toggle_state(select) !== 1) {
                throw new PresenterError(
                    "The canvas's active tool is not Select and I couldn't change it. "
                    + "A click with Delete active would delete the device, so I won't click."
                );
            }
            steps.push("Select tool activated");
        }
        // Zoomed out on a large network, the whole scene fits in the viewport, so
        // centring cannot bring the device to the middle and the click misses. Reset to
        // 100% (where device_point() is calibrated) and give the user's zoom back after.
        const zoom = Math.trunc(st["zoom"] ?? 0);
        const buttons = {};
        for (const e of els) {
            if (["Zoom Reset", "Zoom In", "Zoom Out"].includes(e.name)) {
                buttons[e.name] = e;
            }
        }
        if (zoom !== 0 && "Zoom Reset" in buttons) {
            u.invoke(buttons["Zoom Reset"]);
            await this._sleep(0.3);
            st = await this._state(device);
            steps.push("zoom reset to 100% to click the device");
            try {
                return await this._click_device(u, main, pid, device, st, steps);
            } finally {
                const [btn_name, times] = zoom_restore_plan(zoom);
                for (let k = 0; k < (btn_name in buttons ? times : 0); k++) {
                    u.invoke(buttons[btn_name]);
                    await this._sleep(0.1);
                }
                if (times) {
                    steps.push(`zoom restored (${zoom})`);
                }
            }
        }
        return this._click_device(u, main, pid, device, st, steps);
    }

    async _click_device(u, main, pid, device, st, steps) {
        const els = u.descendants(main);
        const vp = els.find((e) => e.automation_id.endsWith("CLogicalWorkspace.QWidget")) ?? null;
        if (vp === null) {
            throw new PresenterError("Can't find PT's logical canvas.");
        }
        const bars = {
            "h": els.find((e) => e.automation_id.includes("CLogicalWorkspace.qt_scrollarea_hcontainer")
                && e.automation_id.endsWith("QScrollBar")) ?? null,
            "v": els.find((e) => e.automation_id.includes("CLogicalWorkspace.qt_scrollarea_vcontainer")
                && e.automation_id.endsWith("QScrollBar")) ?? null,
        };
        const [left, top, right, bottom] = vp.rect();

        const scroll = (axis) => {
            const bar = bars[axis];
            try {
                return bar !== null ? u.range_value(bar) : 0.0;
            } catch (e) {
                return 0.0;
            }
        };

        const device_point = () => {
            // At 100% zoom (getCurrentZoom()==0) the scene is shown 1:1, offset
            // by the scrollbar values. Calibrated: a PC at scene (199,400) with
            // the bars at 0 lands at viewport (199,400).
            return [Math.trunc(left + st["cx"] - scroll("h")), Math.trunc(top + st["cy"] - scroll("v"))];
        };

        const inside = (x, y) => left + 8 < x && x < right - 8 && top + 8 < y && y < bottom - 8;

        const center = [Math.floor((left + right) / 2), Math.floor((top + bottom) / 2)];
        let x, y;
        if (Math.trunc(st["zoom"] ?? 0) === 0) {
            [x, y] = device_point();
            if (!inside(x, y)) {
                await this._js(center_on_js(device));
                await this._sleep(0.2);
                [x, y] = device_point();
                steps.push("canvas centred on the device");
            }
        } else {
            await this._js(center_on_js(device));
            await this._sleep(0.2);
            [x, y] = center;
            steps.push("canvas centred on the device (zoom other than 100%)");
        }

        win32.post_click(main, x, y);
        let hwnd = await this._wait_window(pid, device, 3.0);
        if (hwnd === null && (x !== center[0] || y !== center[1])) {
            // Second attempt: centre and click the middle of the viewport.
            await this._js(center_on_js(device));
            await this._sleep(0.25);
            win32.post_click(main, center[0], center[1]);
            hwnd = await this._wait_window(pid, device, 3.0);
        }
        if (hwnd === null) {
            throw new PresenterError(
                `The dialog for '${device}' did not open. Is it inside a cluster or covered by `
                + "another device? Try opening it once by hand."
            );
        }
        steps.push("dialog opened (click posted, cursor not moved)");
        return hwnd;
    }

    _select_tab(u, hwnd, tab) {
        const tabs = u.descendants(hwnd, "TabItem");
        const match = tabs.find((e) => names.tab_matches(tab, e.name)) ?? null;
        if (match === null) {
            const have = [...new Set(tabs.map((e) => e.name))].join(", ") || "(none)";
            throw new PresenterError(`Tab '${tab}' does not exist on this device. It has: ${have}.`);
        }
        u.select(match);
    }

    _open_section(u, hwnd, section) {
        const key = names.normalize(section);
        const clickable = new Set([u.m.UIA_CheckBoxControlTypeId, u.m.UIA_ButtonControlTypeId,
            u.m.UIA_ListItemControlTypeId]);
        for (const e of u.descendants(hwnd)) {
            if (clickable.has(e.control_type) && !e.offscreen && names.normalize(e.name) === key) {
                u.invoke(e);
                return;
            }
        }
        throw new PresenterError(
            `Can't find section '${section}' in the current tab `
            + "(in Config: 'Settings', 'FastEthernet0'...; in Services: 'DHCP', 'DNS', 'HTTP'...)."
        );
    }

    async _open_app(u, hwnd, app, { reopen = false } = {}) {
        const obj = names.desktop_app_object_name(app);
        if (obj === null) {
            throw new PresenterError(
                `Unknown app '${app}'. Apps: ${names.known_apps().join(", ")}.`
            );
        }
        let els = u.descendants(hwnd);
        // Is an app open on top of the desktop? Its title bar tells.
        const titles = applet_parts(els, APPLET_TITLES);
        if (titles.length) {
            const outer = titles.reduce((a, b) => (b.automation_id.length < a.automation_id.length ? b : a));
            if (names.desktop_app_object_name(outer.name) === obj && !reopen) {
                return `app ${outer.name.trim()} already open`;
            }
            // Email opens a sub-panel (Configure Mail) and PT ignores closing the
            // outer panel while the inner one is shown: close from the inside
            // out until none is left.
            for (let k = 0; k < 4; k++) {
                const closers = applet_parts(els, APPLET_CLOSERS);
                if (!closers.length) {
                    break;
                }
                u.invoke(closers.reduce((a, b) => (b.automation_id.length > a.automation_id.length ? b : a)));
                await this._sleep(0.3);
                els = u.descendants(hwnd);
            }
        }
        let btn = els.find((e) => e.automation_id.endsWith("." + obj)) ?? null;
        // In case the desktop takes a moment to return to the UIA tree after
        // closing the app: retry briefly before giving up.
        for (let k = 0; k < 8; k++) {
            if (btn !== null) {
                break;
            }
            await this._sleep(0.25);
            btn = u.descendants(hwnd).find((e) => e.automation_id.endsWith("." + obj)) ?? null;
        }
        if (btn === null) {
            throw new PresenterError(
                `This device has no '${app}' app on its Desktop.`
            );
        }
        u.invoke(btn);
        return `app ${app} opened`;
    }

    async fill_and_go(hwnd, edit_suffix, text, button_suffix) {
        /** Write `text` into the field whose AutomationId ends in `edit_suffix`
         * and press the `button_suffix` button (e.g. the Web Browser's URL + Go). */
        const u = new Uia();
        const els = u.descendants(hwnd).filter((e) => !e.offscreen);
        const edit = els.find((e) => e.automation_id.endsWith(edit_suffix)) ?? null;
        const btn = els.find((e) => e.automation_id.endsWith(button_suffix)) ?? null;
        if (edit === null || btn === null) {
            return false;
        }
        for await (const guard of win32.keep_user_focus(win32.window_pid(hwnd))) {
            void guard;
            u.set_value(edit, text);
            u.invoke(btn);
        }
        return true;
    }

    async invoke_button(hwnd, name) {
        /** Press (Invoke) a visible button of the dialog by its text, e.g. the OK
         * of "Terminal Configuration". False if it isn't there. */
        const u = new Uia();
        for (const e of u.descendants(hwnd, "Button")) {
            if (!e.offscreen && e.name.trim().toLowerCase() === name.trim().toLowerCase()) {
                for await (const guard of win32.keep_user_focus(win32.window_pid(hwnd))) {
                    void guard;
                    u.invoke(e);
                }
                return true;
            }
        }
        return false;
    }

    scroll_consoles(hwnd, u = null) {
        /** Scroll the visible consoles (CLI / Command Prompt / Terminal) to the end. */
        if (u === null) {
            u = new Uia();
        }
        let moved = false;
        for (const e of u.descendants(hwnd, "ScrollBar")) {
            if (e.automation_id.includes("CCommandLine") && !e.offscreen) {
                try {
                    u.scroll_to_end(e);
                    moved = true;
                } catch (err) {
                    // Python: except Exception: pass
                }
            }
        }
        return moved;
    }

    // -- close / capture --------------------------------------------------
    async close(device = "") {
        if (device) {
            return (await this._js(show_dialog_js(device, false))) === "ok" ? "closed" : "was not open";
        }
        await this._js(close_all_js());
        return "all dialogs closed";
    }

    async capture(device, target) {
        const [ok, why] = is_available();
        if (!ok) {
            throw new PresenterError(why);
        }
        const pid = await this._pid();
        const hwnd = device ? win32.find_window(pid, device) : win32.main_window(pid);
        if (hwnd === null) {
            throw new PresenterError(
                `The dialog for '${device}' is not open. Open it with pt_ui_open `
                + "(or use show=True on the tool you ran)."
            );
        }
        let w, h, bgra;
        for await (const guard of win32.keep_user_focus(pid)) {
            void guard;
            win32.raise_window(hwnd);
            await this._sleep(0.15);
            [w, h, bgra] = win32.capture(hwnd);
        }
        fs.mkdirSync(path.dirname(String(target)), { recursive: true });
        fs.writeFileSync(String(target), bgra_to_png(w, h, bgra));
        return { "path": String(target), "width": w, "height": h, "blank": looks_blank(bgra) };
    }
}
