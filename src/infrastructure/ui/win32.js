// Win32 through ctypes: PT's windows, capture with PrintWindow, and posted clicks.
// (Port of infrastructure/ui/win32.py)
//
// None of this moves the cursor or types into the user's session:
// - Capture uses `PrintWindow(PW_RENDERFULLCONTENT)`, which paints the window
//   into a bitmap even when other windows cover it.
// - The click is a `PostMessage(WM_LBUTTONDOWN/UP)` to PT's main window: Qt
//   handles it as a click at those client coordinates, but the user's real
//   pointer is unaffected (verified: the cursor position does not change).
//
// The click does cost keyboard focus: Qt activates the dialog it opens, so the
// keys the user is typing in another app would land in PT's console. That can't
// be prevented, because the dialog doesn't exist before the click and an explicit
// activation ignores WS_EX_NOACTIVATE. `keep_user_focus()` undoes it instead, as
// soon as it happens. Its limits are listed there.
//
// PLATFORM GATING (Node port): the Python original drives Win32 through ctypes.
// This port has no FFI backend (no external dependencies), so `_load()` — which
// every function below calls first — throws on every platform: off Windows with
// the Python original's own message ("Presenting in PT's GUI is only available
// on Windows.", from `_load()`), and on Windows with a clear error saying the
// ctypes-equivalent FFI layer is not available in the Node runtime. Nothing
// here ever fakes success.

import { sleep as _sleep_ms } from "../../shared/pycompat.js";

const _PW_RENDERFULLCONTENT = 2;
const _WM_MOUSEMOVE = 0x0200, _WM_LBUTTONDOWN = 0x0201, _WM_LBUTTONUP = 0x0202;
const _MK_LBUTTON = 0x0001;
const _SW_SHOWNOACTIVATE = 4, _SW_RESTORE = 9;
const _WPF_RESTORETOMAXIMIZED = 0x2;
const _SWP_NOSIZE = 0x1, _SWP_NOMOVE = 0x2, _SWP_NOACTIVATE = 0x10, _SWP_SHOWWINDOW = 0x40;
const _HWND_TOP = 0;

// How often the guard looks at the foreground window, how long it keeps looking
// after the work ends (Qt can activate a moment late) and how many refused
// restores it tolerates before giving up.
const _FOCUS_POLL_S = 0.02;
const _FOCUS_GRACE_S = 0.1;
const _FOCUS_MAX_FAILURES = 3;

let _loaded = false;
export let user32 = null;
export let gdi32 = null;

export function is_supported() {
    return process.platform === "win32";
}

function _os_error(message) {
    const err = new Error(message);
    err.name = "OSError";
    return err;
}

// The explicit signatures the Python `_load()` declares on user32/gdi32
// (HWNDs are 64-bit), kept as the record of what an FFI backend would bind:
//   EnumWindows, GetWindowThreadProcessId, GetWindowTextLengthW, GetWindowTextW,
//   IsWindowVisible, IsIconic, GetWindowRect, GetWindowDC, ReleaseDC,
//   PrintWindow, ScreenToClient, PostMessageW, ShowWindow, GetWindowPlacement,
//   GetForegroundWindow, SetForegroundWindow, IsWindow, AttachThreadInput,
//   SendInput, SetWindowPos (user32); CreateCompatibleDC, CreateCompatibleBitmap,
//   SelectObject, GetDIBits, DeleteObject, DeleteDC (gdi32);
// plus SetProcessDpiAwarenessContext(-4) so GetWindowRect and UIA talk in the
// same (physical) units on scaled monitors.
function _load() {
    /** Load user32/gdi32 with explicit signatures (HWNDs are 64-bit). */
    if (_loaded) {
        return;
    }
    if (!is_supported()) {
        throw _os_error("Presenting in PT's GUI is only available on Windows.");
    }
    // Windows, but the Node runtime has no ctypes equivalent available to this
    // port (no external FFI dependency): fail loudly, never fake it.
    throw _os_error(
        "Win32 FFI is not available in the Node.js port (the Python original uses "
        + "ctypes on user32/gdi32; no FFI backend is installed for Node), so PT's "
        + "GUI cannot be driven from this runtime."
    );
}

export function top_windows(pid) {
    /** Visible top-level windows of process `pid`: [(hwnd, title)]. */
    _load();
    // Unreachable in this port: _load() throws until an FFI backend exists.
    throw _os_error("Win32 FFI is not available in the Node.js port.");
}

export function find_window(pid, title) {
    for (const [hwnd, t] of top_windows(pid)) {
        if (t === title) {
            return hwnd;
        }
    }
    return null;
}

export function main_window(pid) {
    for (const [hwnd, t] of top_windows(pid)) {
        if (t.startsWith("Cisco Packet Tracer")) {
            return hwnd;
        }
    }
    return null;
}

export function raise_window(hwnd) {
    /** Restore it if minimised and bring it to the front without stealing keyboard focus. */
    _load();
    if (user32.IsIconic(hwnd)) {
        // SW_SHOWNOACTIVATE would un-maximise a window that was minimised while
        // maximised. Only SW_RESTORE keeps that, and it activates, so that one
        // case is left to keep_user_focus().
        // (The _WINDOWPLACEMENT flags check lives in the ctypes original; with
        // no FFI backend this body cannot run — see _load().)
        user32.ShowWindow(hwnd, _SW_SHOWNOACTIVATE);
    }
    user32.SetWindowPos(hwnd, _HWND_TOP, 0, 0, 0, 0,
        _SWP_NOMOVE | _SWP_NOSIZE | _SWP_NOACTIVATE | _SWP_SHOWWINDOW);
}

export function window_pid(hwnd) {
    /** Process that owns `hwnd` (0 if the window is gone). */
    _load();
    // GetWindowThreadProcessId(hwnd, &owner) in the ctypes original.
    throw _os_error("Win32 FFI is not available in the Node.js port.");
}

function _send_empty_input() {
    /** A mouse event that moves nothing: this process then "received the last input event". */
    // _INPUT(type 0 = INPUT_MOUSE, every field zero) + SendInput in the original.
    user32.SendInput(1, null, 0);
}

function _take_foreground(target, current) {
    /** Give the foreground to `target` while `current` holds it.
     *
     * A background process is normally refused by SetForegroundWindow. A refusal is
     * retried after an empty SendInput (PowerToys does this): one of the documented
     * conditions is having received the last input event, and it moves nothing and
     * types nothing. Measured live on PT 9.0.1 that AttachThreadInput alone is not
     * enough, but it stays as the last resort, attached to the foreground window's
     * input queue (what Windows Terminal does to summon itself). The attachment
     * resets the key state, hence only when needed and only for this call.
     *
     * A synthetic ALT would also unlock it, but it's deliberately not used: the
     * letters the user is typing at that instant would become Alt chords.
     */
    if (user32.SetForegroundWindow(target)) {
        return true;
    }
    _send_empty_input();
    if (user32.SetForegroundWindow(target)) {
        return true;
    }
    const mine = process.pid; // the original uses the native thread id
    const theirs = user32.GetWindowThreadProcessId(current, null);
    const attached = Boolean(theirs && theirs !== mine && user32.AttachThreadInput(mine, theirs, true));
    try {
        return Boolean(user32.SetForegroundWindow(target));
    } finally {
        if (attached) {
            user32.AttachThreadInput(mine, theirs, false);
        }
    }
}

export class FocusGuard {
    /** State of one keep_user_focus() scope. `saved == 0` means it does nothing. */

    constructor(pid = 0, saved = 0, restored = 0, failures = 0) {
        this.pid = pid;
        this.saved = saved;
        this.restored = restored;
        this.failures = failures;
    }

    check() {
        /** If PT took the foreground, give it back to the saved window. */
        if (!this.saved || this.failures >= _FOCUS_MAX_FAILURES) {
            return;
        }
        _load();
        const current = user32.GetForegroundWindow();
        if (!current || current === this.saved) {
            return; // 0: a switch is in progress
        }
        if (window_pid(current) !== this.pid) {
            this.saved = current; // the user moved to a third app: follow them
            return;
        }
        if (user32.IsWindow(this.saved) && _take_foreground(this.saved, current)) {
            this.restored += 1;
        } else {
            this.failures += 1;
        }
    }

    notes() {
        if (this.failures >= _FOCUS_MAX_FAILURES) {
            return ["could not give keyboard focus back: PT kept it, click your window"];
        }
        return this.restored ? ["keyboard focus given back to the previous window"] : [];
    }
}

let _guard_locked = false;

function _focus_guard_enabled() {
    if (!is_supported()) {
        return false;
    }
    return !(process.env.PT_UI_KEEP_FOCUS ?? "1").trim().toLowerCase()
        .match(/^(0|false|no|off)$/);
}

export async function* keep_user_focus(pid) {
    /** Keep the user's window in the foreground while PT's GUI is driven.
     *
     * Saves the foreground window and, from a background thread, gives it back each
     * time a window of process `pid` (PT) takes it, both during the block and for a
     * moment after it. It does nothing if the user is already in PT, there is no
     * foreground window, another scope is active (they nest), it isn't Windows or
     * PT_UI_KEEP_FOCUS=0.
     *
     * Limits:
     * - It reacts, it doesn't prevent: keys pressed between PT's activation and the
     *   restore (one poll plus the switch, tens of ms) still reach PT.
     * - Windows may refuse: SetForegroundWindow has no guarantee, a menu open in PT
     *   blocks it, and the attachment can fail against an elevated PT. The guard
     *   then gives up and says so in `notes()`.
     * - A user who clicks PT on purpose during the block is sent back: the guard
     *   can't tell that from PT's own activation. It lasts for the block only.
     *
     * JS port: Python's context manager becomes an async generator —
     * `for await (const guard of keep_user_focus(pid)) { ... }`.
     */
    if (!_focus_guard_enabled() || _guard_locked) {
        yield new FocusGuard();
        return;
    }
    _guard_locked = true;
    try {
        _load();
        const saved = user32.GetForegroundWindow();
        if (!saved || window_pid(saved) === pid) {
            yield new FocusGuard(pid);
            return;
        }
        const guard = new FocusGuard(pid, saved);
        let stopped = false;
        let watcher_done = false;
        const watcher = (async () => {
            // The original polls from a daemon thread every _FOCUS_POLL_S.
            while (!stopped) {
                await _sleep_ms(_FOCUS_POLL_S * 1000);
                if (stopped) {
                    break;
                }
                try {
                    guard.check();
                } catch (e) {
                    break; // a daemon thread dying on error, like the original
                }
            }
            watcher_done = true;
        })();
        try {
            yield guard;
        } finally {
            await _sleep_ms(_FOCUS_GRACE_S * 1000);
            stopped = true;
            await Promise.race([watcher, _sleep_ms(1000)]);
            if (watcher_done) {
                guard.check();
            }
        }
    } finally {
        _guard_locked = false;
    }
}

export function capture(hwnd) {
    /** (width, height, top-down BGRA) of the window, even when it is covered. */
    _load();
    // GetWindowRect → CreateCompatibleDC/Bitmap → PrintWindow(PW_RENDERFULLCONTENT)
    // → GetDIBits in the ctypes original; none of it can run without an FFI
    // backend (see _load()).
    throw _os_error("Win32 FFI is not available in the Node.js port.");
}

export function post_click(hwnd, screen_x, screen_y) {
    /** Left click posted to `hwnd` at a screen point. Returns the client (x, y). */
    _load();
    // ScreenToClient, then PostMessageW(WM_MOUSEMOVE / WM_LBUTTONDOWN with
    // MK_LBUTTON / WM_LBUTTONUP) with lp = ((y & 0xFFFF) << 16) | (x & 0xFFFF)
    // in the ctypes original; it cannot run without an FFI backend (see _load()).
    throw _os_error("Win32 FFI is not available in the Node.js port.");
}
