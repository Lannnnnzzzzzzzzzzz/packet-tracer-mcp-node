// Canvas tools: screenshot, notes, clear annotations, view size, auto layout.

import fs from "node:fs";
import { TIMEOUT_MSG } from "../bridge_context.js";
import { safe_name_component, resolve_within, workdir_subdir } from "../../../shared/utils.js";
import { CanvasImageError, decode_pt_image, normalize_format } from "../../../domain/services/canvas.js";
import { reply_json } from "../../../shared/utils.js";
import { ICON_H, ICON_W, LABEL_H, MARGIN, layout } from "../../../domain/services/layout.js";
import {
    canvas_info_js, layout_inputs, move_devices_js, parse_canvas_info, read_canvas_size,
} from "../../../infrastructure/execution/canvas_view.js";
import { topology_snapshot_js } from "../../../infrastructure/generator/topology_js.js";
import { pyJsonDumps, pyStr, pyTruthy } from "../../../shared/pycompat.js";


export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _TIMEOUT_MSG = TIMEOUT_MSG;
    const _bridge_send_and_wait = async (js, timeout) => await ctx.send_and_wait(js, timeout);
    const _check_bridge = async () => await ctx.check_bridge();

    // ------------------------------------------------------------------
    // CANVAS — capture and annotations
    // ------------------------------------------------------------------

    registry.tool("pt_screenshot", async (args) => {
        const filename = args.filename !== undefined ? args.filename : "topology";
        const fmt = args.fmt !== undefined ? args.fmt : "PNG";
        const output_dir = args.output_dir !== undefined ? args.output_dir : "projects";
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        let image_fmt;
        try {
            image_fmt = normalize_format(fmt);
        } catch (exc) {
            if (exc instanceof CanvasImageError) {
                return pyJsonDumps({"error": String(exc.message !== undefined ? exc.message : exc)}, {ensureAscii: false});
            }
            throw exc;
        }

        const js = (
            "try {"
            + "  var __lw = ipc.appWindow().getActiveWorkspace().getLogicalWorkspace();"
            + `  reportResult(String(__lw.getWorkspaceImage(${pyJsonDumps(image_fmt)})));`
            + "} catch (__e) { reportResult('ERROR:' + __e); }"
        );
        // Generous on purpose: the image travels as text and is hundreds of KB.
        const raw = await _bridge_send_and_wait(js, 45.0);
        if (raw === null || raw === undefined) {
            return (
                "No answer from PT while capturing. On very large canvases the "
                + "image can exceed the bridge's limit; try fmt='PNG'."
            );
        }
        if (raw.startsWith("ERROR:")) {
            return `PT error: ${raw}`;
        }

        let blob;
        try {
            blob = decode_pt_image(raw, image_fmt);
        } catch (exc) {
            if (exc instanceof CanvasImageError) {
                return `Could not decode the image: ${exc.message !== undefined ? exc.message : exc}`;
            }
            throw exc;
        }

        const safe = safe_name_component(filename, "topology");
        const ext = ["JPG", "JPEG"].includes(image_fmt) ? "jpg" : image_fmt.toLowerCase();
        let target;
        try {
            const base = workdir_subdir(output_dir, "projects");
            fs.mkdirSync(base, { recursive: true });
            target = resolve_within(base, `${safe}.${ext}`);
            fs.writeFileSync(target, blob);
        } catch (exc) {
            return `Could not write the image: ${exc && exc.message !== undefined ? exc.message : exc}`;
        }

        return reply_json({
            "path": String(target),
            "format": image_fmt,
            "bytes": blob.length,
            "summary": `✅ Capture saved to ${target} (${blob.length.toLocaleString("en-US")} bytes).`,
        });
    });

    registry.tool("pt_add_note", async (args) => {
        const x = args.x;
        const y = args.y;
        const text = args.text;
        const err = await _check_bridge();
        if (err) {
            return err;
        }
        if (!text.trim()) {
            return pyJsonDumps({"error": "The note is empty."}, {ensureAscii: false});
        }

        // addNote's third argument is the Z-ORDER, not the font size:
        // PT exposes getIncNoteZOrder() precisely to get the next one. Verified
        // by passing 12 and 14 — the notes come out the same size.
        const js = (
            "try {"
            + "  var __lw = ipc.appWindow().getActiveWorkspace().getLogicalWorkspace();"
            + "  var __z = (typeof __lw.getIncNoteZOrder === 'function')"
            + "    ? __lw.getIncNoteZOrder() : 0;"
            + `  reportResult(String(__lw.addNote(${Math.trunc(Number(x))}, ${Math.trunc(Number(y))}, __z, `
            + `${pyJsonDumps(text)})));`
            + "} catch (__e) { reportResult('ERROR:' + __e); }"
        );
        const raw = await _bridge_send_and_wait(js, 10.0);
        if (raw === null || raw === undefined) {
            return _TIMEOUT_MSG;
        }
        if (raw.startsWith("ERROR:")) {
            return `PT error: ${raw}`;
        }
        return reply_json({
            "id": raw.trim(),
            "summary": `✅ Note added at (${x},${y}).`,
        });
    });

    registry.tool("pt_clear_annotations", async (args) => {
        const kind = args.kind !== undefined ? args.kind : "all";
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const what = kind.trim().toLowerCase();
        if (!["all", "notes"].includes(what)) {
            return pyJsonDumps(
                {"error": `Invalid kind: '${kind}'. Use 'all' or 'notes'.`},
                {ensureAscii: false},
            );
        }
        // getCanvasItemIds does NOT include the notes: they are separate sets. Sweeping
        // only one left notes on screen and on top reported remaining=0, which
        // is worse than not deleting — the user believes it is clean.
        const getters = what === "notes" ? ["getCanvasNoteIds"] : [
            "getCanvasNoteIds", "getCanvasItemIds",
        ];
        const js_getters = getters.map((g) => pyJsonDumps(g)).join(", ");
        const js = (
            "try {"
            + "  var __lw = ipc.appWindow().getActiveWorkspace().getLogicalWorkspace();"
            + `  var __gs = [${js_getters}];`
            + "  var __n = 0;"
            + "  for (var __k = 0; __k < __gs.length; __k++) {"
            + "    var __ids = null;"
            + "    try { __ids = __lw[__gs[__k]](); } catch (__ge) { continue; }"
            + "    if (!__ids) continue;"
            + "    for (var __i = 0; __i < __ids.length; __i++) {"
            + "      try { if (__lw.removeCanvasItem(__ids[__i])) __n++; } catch (__re) {}"
            + "    }"
            + "  }"
            // PT leaves orphan note IDs: no text, and removeCanvasItem
            // returning false. Counting them as "remaining" would suggest the
            // cleanup failed when the canvas ended up empty, so they are kept apart.
            + "  var __left = 0, __stale = 0;"
            + "  for (var __m = 0; __m < __gs.length; __m++) {"
            + "    var __rest = null;"
            + "    try { __rest = __lw[__gs[__m]]() || []; } catch (__le) { continue; }"
            + "    for (var __q = 0; __q < __rest.length; __q++) {"
            + "      var __has = true;"
            + "      try {"
            + "        if (typeof __lw.getCanvasNoteText === 'function') {"
            + "          __has = String(__lw.getCanvasNoteText(__rest[__q]) || '') !== '';"
            + "        }"
            + "      } catch (__te) {}"
            + "      if (__has) { __left++; } else { __stale++; }"
            + "    }"
            + "  }"
            + "  reportResult(JSON.stringify({ removed: __n, remaining: __left,"
            + "    stale_ids: __stale }));"
            + "} catch (__e) { reportResult('ERROR:' + __e); }"
        );
        const raw = await _bridge_send_and_wait(js, 20.0);
        if (raw === null || raw === undefined) {
            return _TIMEOUT_MSG;
        }
        if (raw.startsWith("ERROR:")) {
            return `PT error: ${raw}`;
        }
        let data;
        try {
            data = JSON.parse(raw);
        } catch (exc) {
            return `Unreadable reply from PT: ${exc.message !== undefined ? exc.message : exc}`;
        }
        data["kind"] = what;
        const stale = data["stale_ids"] !== undefined && data["stale_ids"] !== null ? data["stale_ids"] : 0;
        // The orphan ids are not a failure: PT never releases them and the canvas
        // is visually clean anyway. They are mentioned without alarm.
        const nota = stale ? ` (${stale} orphan id(s) that PT does not release).` : ".";
        data["summary"] = (
            data["removed"]
            ? `✅ ${data['removed']} annotation(s) removed${nota}`
            : `There were no annotations to remove${nota}`
        );
        return reply_json(data);
    });

    // ------------------------------------------------------------------
    // CANVAS — size and layout
    // ------------------------------------------------------------------

    registry.tool("pt_canvas_info", async (args) => {
        const err = await _check_bridge();
        if (err) {
            return err;
        }
        const data = parse_canvas_info(await _bridge_send_and_wait(canvas_info_js(), 8.0));
        if (data === null || data === undefined) {
            return _TIMEOUT_MSG;
        }
        const [w, h] = data["view"];
        data["usable_x"] = [MARGIN, Math.max(MARGIN, w - MARGIN - ICON_W)];
        data["usable_y"] = [MARGIN, Math.max(MARGIN, h - MARGIN - ICON_H - LABEL_H)];
        const zoom = data["zoom"] !== undefined ? data["zoom"] : null;
        data["summary"] = (
            `Visible view ${w}x${h} px at zoom ${zoom === null ? "None" : zoom} (0 = 100 %). Place icons with x in `
            + `[${data['usable_x'].join(", ")}] and y in [${data['usable_y'].join(", ")}].`
            + (pyTruthy(data["bbox"]) ? ` Devices: ${data['devices']}, bbox [${(data['bbox'] || []).join(", ")}].` : "")
            + (zoom !== 0 && zoom !== null && zoom !== undefined ? " PT is zoomed: the visible area in canvas px differs." : "")
        );
        return reply_json(data);
    });

    registry.tool("pt_auto_layout", async (args) => {
        const apply = args.apply !== undefined ? args.apply : true;
        const err = await _check_bridge();
        if (err) {
            return err;
        }
        const raw = await _bridge_send_and_wait(topology_snapshot_js(), 15.0);
        if (raw === null || raw === undefined) {
            return _TIMEOUT_MSG;
        }
        let snapshot;
        try {
            snapshot = JSON.parse(raw);
        } catch (e) {
            return `Unreadable reply from PT: ${raw.slice(0, 200)}`;
        }
        if (!(snapshot && snapshot["ok"])) {
            return `PT error: ${raw.slice(0, 200)}`;
        }
        const [devices, links] = layout_inputs(snapshot);
        if (!devices.length) {
            return "The canvas has no devices to arrange.";
        }
        const canvas = await read_canvas_size(async (js, t) => await _bridge_send_and_wait(js, t));
        const result = layout(devices, links, canvas);
        const positions_obj = {};
        const pos_entries = result.positions instanceof Map ? [...result.positions.entries()] : Object.entries(result.positions);
        for (const [n, p] of pos_entries) positions_obj[n] = [...p];
        const data = {
            "canvas": [...result.canvas], "canvas_read": canvas !== null && canvas !== undefined,
            "shape": result.shape, "fits": result.fits, "size": [...result.size],
            "notes": result.notes,
            "positions": positions_obj,
        };
        if (!apply) {
            data["summary"] = `Layout computed for ${devices.length} device(s); nothing moved (apply=False).`;
            return reply_json(data);
        }
        const moved_raw = await _bridge_send_and_wait(move_devices_js(result.positions), 20.0);
        if (moved_raw === null || moved_raw === undefined) {
            return _TIMEOUT_MSG;
        }
        let moved;
        try {
            moved = JSON.parse(moved_raw);
        } catch (e) {
            return `Unreadable reply from PT: ${moved_raw.slice(0, 200)}`;
        }
        for (const k of ["moved", "missing", "mismatched"]) data[k] = moved[k] !== undefined ? moved[k] : null;
        data["verified"] = Boolean(moved["ok"]) && moved["moved"] === pos_entries.length;
        data["summary"] = (
            (data["verified"]
            ? `✅ ${moved['moved']}/${pos_entries.length} device(s) moved (${result.shape} core) `
              + `to fit ${result.canvas[0]}x${result.canvas[1]}.`
            : `⚠ Moved ${moved['moved']}/${pos_entries.length}; missing ${pyStr(moved['missing'] !== undefined && moved['missing'] !== null ? moved['missing'] : null)}, `
                 + `mismatched ${pyStr(moved['mismatched'] !== undefined && moved['mismatched'] !== null ? moved['mismatched'] : null)}.`
            ) + (result.fits ? "" : " " + result.notes.slice(-1).join(" "))
        );
        return reply_json(data);
    });
}
