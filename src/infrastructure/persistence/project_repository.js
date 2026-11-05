// Project repository: persistence of plans and artifacts.
// (Port of infrastructure/persistence/project_repository.py)

import fs from "node:fs";
import path from "node:path";

import { TopologyPlan } from "../../domain/models/plans.js";
import { safe_name_component, resolve_within } from "../../shared/utils.js";
import { pyJsonDumps } from "../../shared/pycompat.js";

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

export class ProjectRepository {
    /** Manages project persistence. */

    constructor(base_dir = "projects") {
        this.base_dir = String(base_dir);
        fs.mkdirSync(this.base_dir, { recursive: true });
    }

    save_plan(plan, project_name = null) {
        /** Saves a plan as JSON. */
        const base_name = (project_name || plan.name || "topology").trim() || "topology";
        const name = safe_name_component(base_name);
        const project_dir = resolve_within(this.base_dir, name);
        fs.mkdirSync(project_dir, { recursive: true });

        const plan_path = path.join(project_dir, "plan.json");
        fs.writeFileSync(plan_path, _plan_dump_json(plan), "utf-8");

        // Metadata
        const meta_path = path.join(project_dir, "metadata.json");
        const meta = {
            "project_name": name,
            "created_at": _utc_now_iso(),
            "devices": plan.devices.length,
            "links": plan.links.length,
            "is_valid": plan.is_valid,
        };
        fs.writeFileSync(meta_path, pyJsonDumps(meta, { indent: 2 }), "utf-8");

        return plan_path;
    }

    load_plan(project_name) {
        /** Loads a plan from JSON. */
        const plan_path = resolve_within(
            this.base_dir, safe_name_component(project_name), "plan.json"
        );
        if (!fs.existsSync(plan_path)) {
            const err = new Error(`Project '${project_name}' not found`);
            err.code = "ENOENT";
            throw err;
        }
        // TopologyPlan.model_validate_json(text)
        return new TopologyPlan(JSON.parse(fs.readFileSync(plan_path, "utf-8")));
    }

    list_projects() {
        /** Lists all saved projects. */
        const projects = [];
        const entries = fs.readdirSync(this.base_dir, { withFileTypes: true })
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const d of entries) {
            if (d.isDirectory()) {
                const meta_path = path.join(this.base_dir, d.name, "metadata.json");
                if (fs.existsSync(meta_path)) {
                    const meta = JSON.parse(fs.readFileSync(meta_path, "utf-8"));
                    projects.push(meta);
                } else {
                    projects.push({ "project_name": d.name });
                }
            }
        }
        return projects;
    }

    delete_project(project_name) {
        /** Deletes a project. */
        // Confined rmtree: without resolve_within, a project_name containing ".."
        // would recursively delete any directory on the machine.
        const project_dir = resolve_within(this.base_dir, safe_name_component(project_name));
        if (!fs.existsSync(project_dir)) {
            return false;
        }
        fs.rmSync(project_dir, { recursive: true, force: true });
        return true;
    }
}
