// Minimal PNG encoder (8-bit RGB), no dependencies.
// (Port of infrastructure/ui/png.py)
//
// Captures come out of `GetDIBits` as top-down BGRA. Pillow is not a project
// dependency and isn't worth adding for this: an unfiltered zlib-compressed PNG
// is a twenty-line format.

import zlib from "node:zlib";

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC-32 (PNG polynomial), matching zlib.crc32.
const _CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function _crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = _CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function _chunk(tag, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(_crc32(Buffer.concat([tag, data])), 0);
    return Buffer.concat([len, tag, data, crc]);
}

export function bgra_to_png(width, height, bgra, level = 6) {
    /** Convert a BGRA buffer (width*height*4, rows top to bottom) to PNG. */
    if (width <= 0 || height <= 0) {
        throw new Error("invalid dimensions");
    }
    if (bgra.length < width * height * 4) {
        throw new Error("buffer smaller than width*height*4");
    }
    const stride = width * 4;
    const rgb_row = width * 3;
    const raw = Buffer.alloc((rgb_row + 1) * height);
    for (let y = 0; y < height; y++) {
        const row = bgra.subarray(y * stride, (y + 1) * stride);
        const out = y * (rgb_row + 1);
        raw[out] = 0; // filter "None"
        const line = Buffer.alloc(rgb_row);
        // Strided slicing: the BGRA→RGB reorder, channel by channel.
        for (let x = 0; x < width; x++) {
            line[x * 3] = row[x * 4 + 2];
            line[x * 3 + 1] = row[x * 4 + 1];
            line[x * 3 + 2] = row[x * 4];
        }
        line.copy(raw, out + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type RGB
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    return Buffer.concat([
        PNG_SIGNATURE,
        _chunk(Buffer.from("IHDR", "ascii"), ihdr),
        _chunk(Buffer.from("IDAT", "ascii"), zlib.deflateSync(raw, { level })),
        _chunk(Buffer.from("IEND", "ascii"), Buffer.alloc(0)),
    ]);
}

export function looks_blank(bgra, samples = 4000) {
    /** True if the capture is a single colour (PrintWindow returns black when it fails). */
    const n = Math.floor(bgra.length / 4);
    if (n === 0) {
        return true;
    }
    const step = Math.max(1, Math.floor(n / samples));
    const first = bgra.subarray(0, 3);
    for (let i = 0; i < n; i += step) {
        const px = bgra.subarray(i * 4, i * 4 + 3);
        if (!(px[0] === first[0] && px[1] === first[1] && px[2] === first[2])) {
            return false;
        }
    }
    return true;
}
