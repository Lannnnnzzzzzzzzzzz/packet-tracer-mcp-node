// Golden-test runner (Node port): executes scripts/golden_cases.json against the
// JS port and writes canonical results to stdout as JSON, same shape as
// golden_py.py so the two can be diffed.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pyJsonDumps } from "../src/shared/pycompat.js";

const ROOT = "/home/hatch/workspace/packet-tracer-mcp-node";
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/golden_cases.json"), "utf-8"));

const moduleCache = new Map();
async function loadModule(dotted) {
    // "infrastructure.generator.walk_js" -> src/infrastructure/generator/walk_js.js
    // (Python folder `generator`, not `generators`.)
    if (!moduleCache.has(dotted)) {
        const rel = dotted.replaceAll(".", "/") + ".js";
        moduleCache.set(dotted, await import(pathToFileURL(path.join(ROOT, "src", rel)).href));
    }
    return moduleCache.get(dotted);
}

async function build(value) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && "$model" in value) {
        const [modPath, clsName] = value["$model"].split(":");
        const mod = await loadModule(modPath);
        const Klass = mod[clsName];
        const fields = {};
        for (const [k, v] of Object.entries(value["fields"])) fields[k] = await build(v);
        return new Klass(fields);
    }
    if (Array.isArray(value)) {
        const out = [];
        for (const v of value) out.push(await build(v));
        return out;
    }
    if (value !== null && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = await build(v);
        return out;
    }
    if (typeof value === "string" && value.startsWith("$") && value.slice(1) in spec) {
        return build(spec[value.slice(1)]);
    }
    return value;
}

function deepConvert(v) {
    if (v !== null && typeof v === "object") {
        if (typeof v.toDict === "function") return deepConvert(v.toDict());
        if (Array.isArray(v)) return v.map(deepConvert);
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = deepConvert(val);
        return out;
    }
    return v;
}

function canon(result) {
    if (typeof result === "string") return { kind: "str", value: result };
    return { kind: "json", value: pyJsonDumps(deepConvert(result), { ensureAscii: false }) };
}

const out = {};
for (const testCase of spec["cases"]) {
    const cid = testCase.id;
    try {
        const mod = await loadModule(testCase.module);
        if ("const" in testCase) {
            out[cid] = canon(mod[testCase.const]);
        } else {
            const fn = mod[testCase.fn];
            if (typeof fn !== "function") throw new Error(`not a function: ${testCase.fn}`);
            const args = [];
            for (const a of testCase.args || []) args.push(await build(a));
            const kwargs = testCase.kwargs || {};
            const kwKeys = Object.keys(kwargs);
            let result;
            if (kwKeys.length) {
                const kw = {};
                for (const k of kwKeys) kw[k] = await build(kwargs[k]);
                result = await fn(...args, kw);
            } else {
                result = await fn(...args);
            }
            out[cid] = canon(result);
        }
    } catch (e) {
        out[cid] = { kind: "error", value: `${e.name || "Error"}: ${e.message}` };
    }
}
console.log(JSON.stringify(out, null, 1));
