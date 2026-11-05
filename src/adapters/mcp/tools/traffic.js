// Traffic tools: originate a simple PDU, fast-forward PT's clock.

import { validate_send_pdu } from "../../../domain/rules/simulation_rules.js";
import { trace_report } from "../../../domain/services/packet_trace.js";
import {
    packet_trace_js, pdu_code_meaning, send_pdu_js, simulation_mode_js, simulation_step_js,
} from "../../../infrastructure/generator/simulation_js.js";
import { pyTruthy } from "../../../shared/pycompat.js";
import { reply_json } from "../../../shared/utils.js";
import { TIMEOUT_MSG } from "../bridge_context.js";
import { errors_text } from "../panel_support.js";

// Frames read back after stepping a PDU: enough for a few hops plus ARP.
export const PDU_TRACE_LIMIT = 30;


export function parse_reply(raw) {
    /** A JSON reply from PT as [data, null], or [null, message for the model]. */
    if (raw === null || raw === undefined) {
        return [null, TIMEOUT_MSG];
    }
    if (raw.startsWith("ERROR:") || raw.startsWith("PT_ERROR")) {
        return [null, `PT error: ${raw}`];
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return [null, `Unreadable reply from PT: ${raw.slice(0, 300)}`];
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
        return [null, `Unreadable reply from PT: ${raw.slice(0, 300)}`];
    }
    return [data, null];
}


export function pdu_error_text(data, source, destination) {
    const err = data["error"] !== undefined && data["error"] !== null ? data["error"] : null;
    if (err === "source_not_found") {
        return `'${source}' does not exist in the active topology (pt_query_topology).`;
    }
    if (err === "destination_not_found") {
        return `'${destination}' does not exist in the active topology (pt_query_topology).`;
    }
    return `PT error: ${data["detail"] || err}`;
}


export function pdu_summary(out) {
    /** One line on what happened to the PDU, from what pt_send_pdu gathered. */
    const head = `${out['source']} → ${out['destination']}`;
    if (out["code"] !== 0) {
        return `${head}: PT did not add the PDU (${out['result']}).`;
    }
    if (out["mode"] === "Realtime") {
        return (`${head}: PDU added in Realtime; PT delivers it at once. Its result shows in `
                + "the GUI's PDU list; to follow it hop by hop use simulation=True.");
    }
    const trace = out["trace"] !== undefined && out["trace"] !== null ? out["trace"] : null;
    if (!pyTruthy(trace)) {
        return (`${head}: PDU queued in Simulation's event list. Step it with `
                + "pt_simulation_step and read it with pt_read_packet_trace.");
    }
    return `${head}: ${trace["summary"] !== undefined && trace["summary"] !== null ? trace["summary"] : ""}`;
}


export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */

    registry.tool("pt_send_pdu", async (args) => {
        const source = args.source;
        const destination = args.destination;
        const simulation = args.simulation !== undefined ? args.simulation : true;
        const steps = args.steps !== undefined ? args.steps : 0;
        const v = validate_send_pdu(source, destination, steps);
        if (!v.is_valid) {
            return errors_text(v);
        }
        const err = await ctx.check_bridge();
        if (err) {
            return err;
        }
        const src = source.trim(), dst = destination.trim();
        const out = {"source": src, "destination": dst};

        let error;
        let mode;
        [mode, error] = parse_reply(await ctx.send_and_wait(simulation_mode_js(simulation), 10.0));
        if (error) {
            return error;
        }
        out["mode"] = mode["after"] ? "Simulation" : "Realtime";

        let added;
        [added, error] = parse_reply(await ctx.send_and_wait(send_pdu_js(src, dst), 10.0));
        if (error) {
            return error;
        }
        if (!added["ok"]) {
            return pdu_error_text(added, src, dst);
        }
        out["code"] = added["code"] !== undefined ? added["code"] : null;
        out["result"] = pdu_code_meaning(out["code"]);

        if (out["code"] === 0 && steps > 0 && out["mode"] === "Simulation") {
            let step;
            [step, error] = parse_reply(
                await ctx.send_and_wait(simulation_step_js("forward", steps), 15.0));
            if (error) {
                return error;
            }
            out["steps"] = steps;
            out["sim_time"] = step["sim_time"] !== undefined ? step["sim_time"] : null;
            let data;
            [data, error] = parse_reply(
                await ctx.send_and_wait(packet_trace_js(PDU_TRACE_LIMIT), 20.0));
            if (error) {
                return error;
            }
            out["trace"] = trace_report(data);
        } else if (steps > 0 && out["mode"] === "Realtime") {
            out["note"] = "steps is ignored in Realtime: there is no event list to step.";
        }
        out["summary"] = pdu_summary(out);
        return reply_json(out);
    });

    registry.tool("pt_fast_forward", async (args) => {
        const err = await ctx.check_bridge();
        if (err) {
            return err;
        }
        const data = await ctx.fast_forward();
        if (!data["ok"]) {
            if (data["error"] === "timeout") {
                return TIMEOUT_MSG;
            }
            return `PT error: ${data["detail"] || data["error"]}`;
        }
        if (data["simulation_mode"]) {
            data["summary"] = ("PT is in Simulation mode: nothing was fast-forwarded. Use "
                               + "pt_simulation_step, or pt_simulation_mode(on=False) first.");
        } else {
            data["summary"] = "PT's clock moved ahead: links cabled moments ago are past STP.";
        }
        return reply_json(data);
    });
}
