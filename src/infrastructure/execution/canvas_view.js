// The live canvas: how big the visible logical view is, and rearranging what is on it.
// (Port of infrastructure/execution/canvas_view.py)
//
// Facts measured on PT 9.0.1 (macOS, 2026-11-03) this module relies on:
// - `ipc.appWindow().getMainViewAreaWidth()` / `getMainViewAreaHeight()` answer the size of
//   the visible logical view in screen points: 1512x599 on a 14" MacBook with PT maximised
//   (window 1512x921; the rest is toolbars and the device palette). A screen capture of the
//   window matched that area to the pixel.
// - `lw.getCurrentZoom()` answers 0 at 100 %. PT zooms out by itself with many devices
//   (zoom -5 was seen); the factor per step is not measured, so a non-zero zoom is only
//   reported, and the size is taken as is.
// - A device's x/y is the top-left corner of its icon; labels hang below it.
// - Every topology carries a "Power Distribution Device" at about (3899, 3900), off the
//   canvas. It is not part of the drawing and is never moved.
//
// Same rules as the other generators: one `json.dumps` config object, every PT call in a
// try/catch, results through reportResult.

import { resolve_model } from "../catalog/devices.js";
import { WALK_JS } from "../generator/walk_js.js";
import { pyJsonDumps } from "../../shared/pycompat.js";

// Hidden device PT adds to every topology (physical view power); never laid out.
const _PHANTOM_PREFIX = "Power Distribution Device";

export function canvas_info_js() {
    /** View size, zoom, window size and the bounding box of the devices. */
    return (
        "(function(){try{" + WALK_JS + "var aw=ipc.appWindow();"
        + "var lw=aw.getActiveWorkspace().getLogicalWorkspace();"
        + "var r={ok:true,view:[aw.getMainViewAreaWidth(),aw.getMainViewAreaHeight()],"
        + "window:[aw.getWidth(),aw.getHeight()],zoom:null,devices:0,bbox:null};"
        + "try{r.zoom=lw.getCurrentZoom();}catch(e){}"
        + "var x0=null,y0=null,x1=null,y1=null;"
        + "__eachDevice(function(d){var n=String(d.getName());"
        + `if(n.indexOf(${pyJsonDumps(_PHANTOM_PREFIX)})===0){return;}`
        + "var x=d.getXCoordinate(),y=d.getYCoordinate();r.devices++;"
        + "if(x0===null||x<x0){x0=x;}if(y0===null||y<y0){y0=y;}"
        + "if(x1===null||x>x1){x1=x;}if(y1===null||y>y1){y1=y;}});"
        + "if(x0!==null){r.bbox=[x0,y0,x1,y1];}"
        + "reportResult(JSON.stringify(r));"
        + "}catch(e){reportResult(JSON.stringify({ok:false,error:String(e)}));}})();"
    );
}

export function parse_canvas_info(raw) {
    /** The canvas_info_js answer as a dict, or None when it is missing or broken. */
    let data;
    try {
        data = JSON.parse(raw || "");
    } catch (e) {
        return null;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data) || !data["ok"]) {
        return null;
    }
    const view = data["view"] || [];
    if (view.length !== 2 || !view.every((v) => (typeof v === "number") && v > 0)) {
        return null;
    }
    return data;
}

export async function read_canvas_size(send) {
    /** (width, height) of the visible logical view, or None if PT does not answer. */
    const data = parse_canvas_info(await send(canvas_info_js(), 5.0));
    if (!data) {
        return null;
    }
    const [w, h] = data["view"];
    return [Math.trunc(w), Math.trunc(h)];
}

export function category_of(model, name = "") {
    /** Layout category of a live device, from its model. */
    const m = model ? resolve_model(model) : null;
    if (m) {
        return m.category;
    }
    const low = (model || name).toLowerCase();
    for (const [key, cat] of [["cloud", "cloud"], ["router", "router"], ["switch", "switch"],
        ["server", "server"], ["laptop", "laptop"], ["access", "accesspoint"],
        ["printer", "printer"], ["phone", "phone"], ["pc", "pc"]]) {
        if (low.includes(key)) {
            return cat;
        }
    }
    return "host";
}

export function layout_inputs(snapshot) {
    /** ([(name, category)], [(a, b)]) of a topology_snapshot_js answer, phantom left out. */
    const devices = (snapshot["devices"] || [])
        .filter((d) => d["name"] && !String(d["name"]).startsWith(_PHANTOM_PREFIX))
        .map((d) => [d["name"], category_of(d["model"] ?? "", d["name"])]);
    const names = new Set(devices.map(([n]) => n));
    const links = [];
    for (const link of (snapshot["links"] || [])) {
        const a = (link["a"] || {})["device"];
        const b = (link["b"] || {})["device"];
        if (names.has(a) && names.has(b)) {
            links.push([a, b]);
        }
    }
    return [devices, links];
}

export function move_devices_js(positions) {
    /** Move every device in one call and read each position back.
     *
     * Answers {ok, moved, missing, mismatched}: a device is mismatched when PT reads a
     * position other than the one asked.
     */
    const p = {};
    for (const [n, [x, y]] of Object.entries(positions)) {
        p[n] = [Math.trunc(x), Math.trunc(y)];
    }
    const cfg = { "p": p };
    return (
        "(function(){try{"
        + `var c=${pyJsonDumps(cfg)};var net=ipc.network();var r={ok:true,moved:0,missing:[],mismatched:[]};`
        + "for(var n in c.p){var d=net.getDevice(n);if(!d){r.missing.push(n);continue;}"
        + "try{d.moveToLocation(c.p[n][0],c.p[n][1]);"
        + "if(d.getXCoordinate()==c.p[n][0]&&d.getYCoordinate()==c.p[n][1]){r.moved++;}"
        + "else{r.mismatched.push(n);}}catch(e){r.mismatched.push(n);}}"
        + "reportResult(JSON.stringify(r));"
        + "}catch(e){reportResult(JSON.stringify({ok:false,error:String(e)}));}})();"
    );
}
