// UI Automation over Packet Tracer's GUI (comtypes).
// (Port of infrastructure/ui/uia.py)
//
// PT is Qt and exposes its whole interface to UIA: each widget shows up with
// AutomationId = its objectName path (e.g. `...m_physicalTab.qt_tabwidget_tabbar`)
// and with a real control's patterns (tabs support SelectionItem, buttons Invoke,
// scrollbars RangeValue). That is enough to pick a tab or open a Desktop app
// without moving the mouse or typing.
//
// Requires `comtypes` (optional extra: `pip install packet-tracer-mcp[ui]`).
//
// PLATFORM GATING (Node port): UI Automation is a Windows COM API and this
// port has no COM backend. `_init()` — called by every `Uia` construction —
// always throws `UiaUnavailable` with the Python original's comtypes message
// (the failure the Python code produces on any machine without the [ui]
// extra), plus a note that the COM layer is unavailable in the Node runtime.
// Nothing here ever fakes success.

let _UIA = null; // generated UIAutomationClient module
let _AUTOMATION = null;

export class UiaUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = "UiaUnavailable";
    }
}

function _init() {
    // The Python original imports comtypes here and raises UiaUnavailable with
    // the message below when it is missing — on any platform (comtypes itself
    // is Windows-only, and the presenter gates on Windows before this). The
    // Node port has no COM backend at all, so it lands in the same place.
    throw new UiaUnavailable(
        "'comtypes' is needed to drive PT's GUI. Install it with "
        + "`pip install packet-tracer-mcp[ui]` (or `pip install comtypes`). "
        + "In the Node.js port the COM/UI Automation layer is not available, "
        + "so PT's GUI cannot be driven from this runtime."
    );
}

export class Element {
    constructor({ raw, name, automation_id, control_type, offscreen } = {}) {
        this.raw = raw;
        this.name = name;
        this.automation_id = automation_id;
        this.control_type = control_type;
        this.offscreen = offscreen;
    }

    rect() {
        const r = this.raw.CurrentBoundingRectangle;
        return [Math.trunc(r.left), Math.trunc(r.top), Math.trunc(r.right), Math.trunc(r.bottom)];
    }
}

export class Uia {
    /** The minimal operations the presenter needs. */

    constructor() {
        [this.m, this.a] = _init();
    }

    // -- search -----------------------------------------------------------
    _wrap(e) {
        return new Element({
            raw: e,
            name: e.CurrentName || "",
            automation_id: e.CurrentAutomationId || "",
            control_type: Math.trunc(e.CurrentControlType),
            offscreen: Boolean(e.CurrentIsOffscreen),
        });
    }

    root(hwnd) {
        return this.a.ElementFromHandle(hwnd);
    }

    descendants(hwnd_or_el, control_type = null) {
        const root = typeof hwnd_or_el === "number" ? this.root(hwnd_or_el) : hwnd_or_el;
        let cond;
        if (control_type) {
            const ct = this.m[`UIA_${control_type}ControlTypeId`];
            cond = this.a.CreatePropertyCondition(this.m.UIA_ControlTypePropertyId, ct);
        } else {
            cond = this.a.CreateTrueCondition();
        }
        const arr = root.FindAll(this.m.TreeScope_Descendants, cond);
        const out = [];
        for (let i = 0; i < arr.Length; i++) {
            out.push(this._wrap(arr.GetElement(i)));
        }
        return out;
    }

    // -- patterns ---------------------------------------------------------
    _pattern(el, pattern, iface) {
        const pid = this.m[`UIA_${pattern}PatternId`];
        const unk = el.raw.GetCurrentPattern(pid);
        if (!unk) {
            throw new UiaUnavailable(`'${el.name}' does not support the ${pattern} pattern`);
        }
        return unk.QueryInterface(this.m[iface]);
    }

    select(el) {
        this._pattern(el, "SelectionItem", "IUIAutomationSelectionItemPattern").Select();
    }

    invoke(el) {
        this._pattern(el, "Invoke", "IUIAutomationInvokePattern").Invoke();
    }

    toggle_state(el) {
        /** 0 = off, 1 = on, 2 = indeterminate. */
        return Math.trunc(this._pattern(el, "Toggle", "IUIAutomationTogglePattern").CurrentToggleState);
    }

    range_value(el) {
        return Number(this._pattern(el, "RangeValue", "IUIAutomationRangeValuePattern").CurrentValue);
    }

    set_value(el, text) {
        /** Write into a field (ValuePattern): does not use the keyboard. */
        this._pattern(el, "Value", "IUIAutomationValuePattern").SetValue(text);
    }

    scroll_to_end(el) {
        const p = this._pattern(el, "RangeValue", "IUIAutomationRangeValuePattern");
        p.SetValue(p.CurrentMaximum);
    }
}
