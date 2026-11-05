// Annotations and capture of Packet Tracer's logical canvas.
//
// Pure logic, no bridge — testable with synthetic data, like topology_diff.
//
// Most of this module exists because of how PT returns an image: it does not send
// binary or base64, but bytes in decimal separated by commas and **signed** (Qt's
// `byte` ranges from -128 to 127). Rebuilding the file means translating each negative
// value to its unsigned equivalent. Verified against PT 9.0.0.0810: the first eight values
// of a PNG come back as `-119,80,78,71,13,10,26,10`, which is exactly the signature
// `89 50 4E 47 0D 0A 1A 0A`.

import { pyStr } from "../../shared/pycompat.js";

// Formats accepted by getWorkspaceImage. Measured: PNG ~33 KB and JPG ~105 KB for the
// same canvas — PNG compresses flat line diagrams much better.
export const IMAGE_FORMATS = ["PNG", "JPG", "JPEG", "BMP"];

// Signatures to verify that the decoded data is really what was requested, instead
// of writing a corrupt file to disk and only reporting it once someone opens it.
const _MAGIC = {
    "PNG": [0x89, 0x50, 0x4E, 0x47],
    "JPG": [0xFF, 0xD8, 0xFF],
    "JPEG": [0xFF, 0xD8, 0xFF],
    "BMP": [0x42, 0x4D],  // b"BM"
};

export class CanvasImageError extends Error {
    /** PT's response could not be converted into an image. */
    constructor(message) {
        super(message);
        this.name = "CanvasImageError";
    }
}

export function normalize_format(fmt) {
    const upper = (fmt || "PNG").trim().toUpperCase();
    if (!IMAGE_FORMATS.includes(upper)) {
        throw new CanvasImageError(
            `Format '${pyStr(fmt === undefined ? null : fmt)}' is not supported. Valid: ${IMAGE_FORMATS.join(", ")}.`
        );
    }
    return upper;
}

// Python int(chunk): optional sign, digits (underscores between digits allowed).
function _pyInt(chunk) {
    const t = chunk.trim();
    if (!/^[+-]?\d(_?\d)*$/.test(t)) return null;
    return parseInt(t.replace(/_/g, ""), 10);
}

export function decode_pt_image(raw, fmt = "PNG") {
    /** Converts PT's signed byte list into the image's binary data. */
    if (!raw || !String(raw).trim()) {
        throw new CanvasImageError("PT returned an empty image.");
    }

    const out = [];
    for (let chunk of String(raw).split(",")) {
        chunk = chunk.trim();
        if (!chunk) {
            continue;
        }
        const value = _pyInt(chunk);
        if (value === null) {
            throw new CanvasImageError(
                `Non-numeric value in the image bytes: '${chunk.slice(0, 20)}'.`
            );
        }
        if (!(-128 <= value && value <= 255)) {
            throw new CanvasImageError(`Byte out of range: ${value}.`);
        }
        // Qt's `byte` is signed; -119 and 137 are the same octet (0x89).
        out.push(value < 0 ? value + 256 : value);
    }

    if (!out.length) {
        throw new CanvasImageError("PT returned an image with no bytes.");
    }

    const magic = _MAGIC[normalize_format(fmt)];
    if (magic && !magic.every((b, i) => out[i] === b)) {
        throw new CanvasImageError(
            `The bytes are not a ${pyStr(fmt === undefined ? null : fmt)}: they start with ` +
            `[${out.slice(0, 4).join(", ")}], expected [${magic.join(", ")}].`
        );
    }
    return Buffer.from(out);
}

export function validate_color(r, g, b, a) {
    /** All four channels range from 0 to 255; PT does not warn if anything else is passed. */
    for (const [name, value] of [["r", r], ["g", g], ["b", b], ["a", a]]) {
        if (!(0 <= value && value <= 255)) {
            throw new Error(`Channel ${name}=${pyStr(value)} is out of range (0-255).`);
        }
    }
}

export function parse_uuid_list(raw) {
    /** Normalizes the canvas ids returned by PT into a list.
     *
     * Depending on the case they arrive as a list already parsed from JSON, or as a
     * single string with the UUIDs in braces separated by commas.
     */
    if (raw === null || raw === undefined) {
        return [];
    }
    if (Array.isArray(raw)) {
        return raw.map((x) => pyStr(x).trim()).filter((s) => s);
    }
    return pyStr(raw).split(",").map((part) => part.trim()).filter((s) => s);
}
