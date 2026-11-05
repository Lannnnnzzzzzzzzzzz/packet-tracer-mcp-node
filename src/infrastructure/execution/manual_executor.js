// Manual executor: exports files so the user can copy/paste them.
// (Port of infrastructure/execution/manual_executor.py)

import fs from "node:fs";
import path from "node:path";

import { generate_ptbuilder_script, generate_full_script } from "../generator/ptbuilder_generator.js";
import { generate_all_configs } from "../generator/cli_config_generator.js";
import { safe_name_component, resolve_within } from "../../shared/utils.js";
import { pyJsonDumps } from "../../shared/pycompat.js";
import { ExecutorBase } from "./executor_base.js";

// datetime.now(timezone.utc).isoformat()
function _utc_now_iso() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
        `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    const ms = d.getUTCMilliseconds();
    // Python shows microseconds (6 digits) when nonzero; JS clocks give ms.
    return (ms ? `${base}.${String(ms).padStart(3, "0")}000` : base) + "+00:00";
}

// plan.model_dump_json(indent=2)
function _plan_dump_json(plan) {
    return pyJsonDumps(plan.toDict(), { indent: 2, ensureAscii: false });
}

export class ManualExecutor extends ExecutorBase {
    /** Generates output files for manual execution. */

    constructor(output_dir = "projects") {
        super();
        this.output_dir = String(output_dir);
    }

    execute(plan, project_name = null) {
        /** Generates all the files for the topology. */
        const base_name = (project_name || plan.name || "topology").trim() || "topology";
        const safe_name = safe_name_component(base_name);
        const project_dir = resolve_within(this.output_dir, safe_name);
        fs.mkdirSync(project_dir, { recursive: true });

        const files = {};

        // PTBuilder script
        const script = generate_ptbuilder_script(plan);
        const script_path = path.join(project_dir, "topology.js");
        fs.writeFileSync(script_path, script, "utf-8");
        files["topology_script"] = String(script_path);

        // Full script (topology + configs as comments)
        const full = generate_full_script(plan);
        const full_path = path.join(project_dir, "full_build.js");
        fs.writeFileSync(full_path, full, "utf-8");
        files["full_script"] = String(full_path);

        // Individual CLI configs
        const configs = generate_all_configs(plan);
        for (const [device_name, config_text] of Object.entries(configs)) {
            const cfg_path = resolve_within(
                project_dir, `${safe_name_component(device_name, "device")}_config.txt`
            );
            fs.writeFileSync(cfg_path, config_text, "utf-8");
            files[`config_${device_name}`] = String(cfg_path);
        }

        // Plan JSON
        const plan_path = path.join(project_dir, "plan.json");
        fs.writeFileSync(plan_path, _plan_dump_json(plan), "utf-8");
        files["plan_json"] = String(plan_path);

        // Project metadata
        const meta_path = path.join(project_dir, "metadata.json");
        const metadata = {
            "project_name": safe_name,
            "created_at": _utc_now_iso(),
            "devices": plan.devices.length,
            "links": plan.links.length,
            "is_valid": plan.is_valid,
        };
        fs.writeFileSync(meta_path, pyJsonDumps(metadata, { indent: 2 }), "utf-8");
        files["metadata"] = String(meta_path);

        return {
            "status": "exported",
            "project_dir": String(project_dir),
            "files": files,
            "devices_count": plan.devices.length,
            "links_count": plan.links.length,
        };
    }

    is_available() {
        return true;
    }
}
