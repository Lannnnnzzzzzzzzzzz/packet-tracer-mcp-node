// Shared check for text fields that end up inside IOS CLI.
//
// Names, remarks and pools travel interpolated in a single-string payload
// that `configureIosDevice()` splits on line breaks and sends to the device
// line by line. A line break inside a "data" field becomes an IOS command
// nobody asked for, so it is rejected during validation instead of being escaped.

// PT splits on \n and \r; U+2028/U+2029 end a line in JS just like \n.
export const LINE_TERMINATORS = ["\n", "\r", " ", " "];

export function has_control_chars(value) {
    /** True if `value` contains anything that would split the payload onto another line. */
    return Boolean(value) && LINE_TERMINATORS.some((ch) => value.includes(ch));
}

// Characters a device name may not carry. PT accepts them (the generated JS is
// json.dumps-escaped, so nothing is injected), but a saved .pkt holding a device
// named with a quote was followed by PT closing itself when it was reopened
// (PT 9.0.1, 2026-10-30, cause not isolated). They serve no purpose in a name.
export const DEVICE_NAME_FORBIDDEN = ['"', "'", "\\", "`"];

export function bad_device_name(value) {
    /** Why a device name is refused, or "" when it is fine. */
    if (!value || !value.trim()) {
        return "the name is empty";
    }
    if (has_control_chars(value)) {
        return "the name contains a line break";
    }
    const bad = [...new Set([...value].filter((ch) => DEVICE_NAME_FORBIDDEN.includes(ch)))]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (bad.length) {
        return "the name contains " + bad.join(" ") + " (quotes, backslash and backtick are not allowed)";
    }
    return "";
}
