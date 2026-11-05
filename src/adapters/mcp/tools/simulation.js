// Simulation tools: mode, step, packet trace.

import { trace_report } from "../../../domain/services/packet_trace.js";
import {
    packet_trace_js, simulation_mode_js, simulation_step_js,
} from "../../../infrastructure/generator/simulation_js.js";
import { TIMEOUT_MSG } from "../bridge_context.js";
import { pyJsonDumps, pyStr } from "../../../shared/pycompat.js";
import { reply_json } from "../../../shared/utils.js";


export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _TIMEOUT_MSG = TIMEOUT_MSG;
    const _bridge_send_and_wait = async (js, timeout) => await ctx.send_and_wait(js, timeout);
    const _check_bridge = async () => await ctx.check_bridge();

    // ------------------------------------------------------------------
    // SIMULATION — mode, step by step and reading the event list
    // ------------------------------------------------------------------

    registry.tool("pt_simulation_mode", async (args) => {
        const on = args.on !== undefined ? args.on : true;
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const js = simulation_mode_js(on);
        const raw = await _bridge_send_and_wait(js, 10.0);
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

        const mode = data["after"] ? "Simulation" : "Realtime";
        data["summary"] = (
            data["before"] !== data["after"]
            ? `${mode} mode. ${data['frames']} frame(s) in the event list.`
            : `Already in ${mode} mode; no changes.`
        );
        return reply_json(data);
    });

    registry.tool("pt_simulation_step", async (args) => {
        const action = args.action !== undefined ? args.action : "forward";
        const times = args.times !== undefined ? args.times : 1;
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const act = action.trim().toLowerCase();
        if (!["forward", "back", "reset"].includes(act)) {
            return pyJsonDumps(
                {"error": `Invalid action: '${action}'. Use forward, back or reset.`},
                {ensureAscii: false},
            );
        }
        const steps = Math.max(1, Math.min(Math.trunc(Number(times)), 100));

        const js = simulation_step_js(act, steps);
        const raw = await _bridge_send_and_wait(js, 15.0);
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

        if (!data["simulation_mode"]) {
            return (
                "PT is in Realtime mode, so there is nothing to step. "
                + "Call pt_simulation_mode(on=True) first."
            );
        }
        data["action"] = act;
        data["steps"] = act === "reset" ? 1 : steps;
        data["summary"] = (
            `${act} x${data['steps']} — ${data['frames_after']} frame(s) in the event list `
            + `(before ${data['frames_before']}).`
        );
        return reply_json(data);
    });

    registry.tool("pt_read_packet_trace", async (args) => {
        const limit = args.limit !== undefined ? args.limit : 20;
        const device = args.device !== undefined ? args.device : "";
        const include_decisions = args.include_decisions !== undefined ? args.include_decisions : true;
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const lim = Math.max(1, Math.min(Math.trunc(Number(limit)), 200));
        const js = packet_trace_js(lim, device.trim(), include_decisions);

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

        const result = trace_report(data);
        return reply_json(result);
    });
}
