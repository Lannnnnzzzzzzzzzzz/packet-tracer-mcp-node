// Deploy executor: copies scripts to the Windows clipboard
// and generates step-by-step instructions for Packet Tracer.
// (Port of infrastructure/execution/deploy_executor.py)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { generate_ptbuilder_script, generate_full_script } from "../generator/ptbuilder_generator.js";
import { generate_all_configs } from "../generator/cli_config_generator.js";
import { safe_name_component, resolve_within } from "../../shared/utils.js";
import { pyJsonDumps, pyTruthy } from "../../shared/pycompat.js";
import { ExecutorBase } from "./executor_base.js";

function _copy_to_clipboard(text) {
    /** Copies text to the Windows clipboard using clip.exe. */
    if (process.platform !== "win32") {
        return false;
    }
    try {
        const res = spawnSync("clip", [], {
            input: Buffer.from(text, "utf16le"),
            timeout: 5000,
        });
        if (res.error) {
            return false;
        }
        return res.status === 0;
    } catch (e) {
        return false;
    }
}

// plan.model_dump_json(indent=2)
function _plan_dump_json(plan) {
    return pyJsonDumps(plan.toDict(), { indent: 2, ensureAscii: false });
}

export class DeployExecutor extends ExecutorBase {
    /**
     * Deploys a topology to Packet Tracer.
     *
     * Strategy:
     * 1. Generates the PTBuilder script (addDevice + addLink)
     * 2. Copies it to the Windows clipboard
     * 3. Exports files to disk (CLI configs, plan JSON)
     * 4. Returns step-by-step instructions
     */

    constructor(output_dir = "projects") {
        super();
        this.output_dir = String(output_dir);
    }

    execute(plan, project_name = null) {
        /** Deploys the plan: clipboard + files + instructions. */
        const base_name = (project_name || plan.name || "topology").trim() || "topology";
        const safe_name = safe_name_component(base_name);
        const project_dir = resolve_within(this.output_dir, safe_name);
        fs.mkdirSync(project_dir, { recursive: true });

        // Generate scripts
        const topology_script = generate_ptbuilder_script(plan);
        const full_script = generate_full_script(plan);
        const configs = generate_all_configs(plan);

        // Copy the topology script to the clipboard
        const clipboard_ok = _copy_to_clipboard(topology_script);

        // Save files to disk
        const files = {};

        const script_path = path.join(project_dir, "topology.js");
        fs.writeFileSync(script_path, topology_script, "utf-8");
        files["topology_script"] = String(script_path);

        const full_path = path.join(project_dir, "full_build.js");
        fs.writeFileSync(full_path, full_script, "utf-8");
        files["full_script"] = String(full_path);

        for (const [device_name, config_text] of Object.entries(configs)) {
            const cfg_path = resolve_within(
                project_dir, `${safe_name_component(device_name, "device")}_config.txt`
            );
            fs.writeFileSync(cfg_path, config_text, "utf-8");
            files[`config_${device_name}`] = String(cfg_path);
        }

        const plan_path = path.join(project_dir, "plan.json");
        fs.writeFileSync(plan_path, _plan_dump_json(plan), "utf-8");
        files["plan_json"] = String(plan_path);

        // Generate instructions
        const instructions = DeployExecutor._build_instructions(
            plan, configs, clipboard_ok, project_dir
        );

        return {
            "status": clipboard_ok ? "deployed" : "exported",
            "clipboard": clipboard_ok,
            "project_dir": String(project_dir),
            "files": files,
            "devices_count": plan.devices.length,
            "links_count": plan.links.length,
            "instructions": instructions,
        };
    }

    is_available() {
        /** Available when running on Windows (for the clipboard). */
        return process.platform === "win32";
    }

    static _build_instructions(plan, configs, clipboard_ok, project_dir) {
        /** Generates step-by-step instructions to complete the deployment. */
        const steps = [];

        // Step 1: PTBuilder script
        steps.push("=".repeat(60));
        steps.push("STEP 1: Create the topology in Packet Tracer");
        steps.push("=".repeat(60));
        if (clipboard_ok) {
            steps.push("The PTBuilder script is already on your clipboard.");
            steps.push("");
            steps.push("  1. Open Packet Tracer");
            steps.push("  2. Go to Extensions > Scripting (or Builder Code Editor)");
            steps.push("  3. Paste the script (Ctrl+V)");
            steps.push("  4. Click 'Run' or press the run button");
            steps.push("");
            steps.push("The devices and links will be created automatically.");
        } else {
            steps.push(`Open the file: ${path.join(project_dir, "topology.js")}`);
            steps.push("Copy its contents and paste them into Packet Tracer:");
            steps.push("  Extensions > Scripting > Paste > Run");
        }

        // Step 2: Configure devices
        const routers = plan.devices.filter((d) => d.category === "router");
        const switches = plan.devices.filter((d) => d.category === "switch");

        if (pyTruthy(configs)) {
            steps.push("");
            steps.push("=".repeat(60));
            steps.push("STEP 2: Configure the devices");
            steps.push("=".repeat(60));

            for (const router of routers) {
                if (Object.prototype.hasOwnProperty.call(configs, router.name)) {
                    steps.push("");
                    steps.push(`  ${router.name}:`);
                    steps.push(`    - Double-click ${router.name} > CLI tab`);
                    steps.push(`    - Paste the contents of: ${path.join(project_dir, `${router.name}_config.txt`)}`);
                }
            }

            for (const sw of switches) {
                if (Object.prototype.hasOwnProperty.call(configs, sw.name)) {
                    steps.push("");
                    steps.push(`  ${sw.name}:`);
                    steps.push(`    - Double-click ${sw.name} > CLI tab`);
                    steps.push(`    - Paste the contents of: ${path.join(project_dir, `${sw.name}_config.txt`)}`);
                }
            }
        }

        // Step 3: Configure PCs
        const pcs = plan.devices.filter((d) => ["pc", "server", "laptop"].includes(d.category));
        if (pcs.length) {
            steps.push("");
            steps.push("=".repeat(60));
            steps.push("STEP 3: Configure the hosts (PCs)");
            steps.push("=".repeat(60));
            for (const pc of pcs) {
                if (pyTruthy(plan.dhcp_pools)) {
                    steps.push(`  ${pc.name}: Desktop > IP Configuration > DHCP`);
                } else if (pyTruthy(pc.interfaces)) {
                    for (const [iface, ip_cidr] of Object.entries(pc.interfaces)) {
                        const ip = ip_cidr.split("/")[0];
                        steps.push(`  ${pc.name}: IP=${ip}, Gateway=${pc.gateway || "N/A"}`);
                    }
                }
            }
        }

        // Step 4: Verify
        if (pyTruthy(plan.validations)) {
            steps.push("");
            steps.push("=".repeat(60));
            steps.push("STEP 4: Verify connectivity");
            steps.push("=".repeat(60));
            for (const v of plan.validations) {
                steps.push(`  ${v.check_type}: ${v.from_device} -> ${v.to_target} (expected: ${v.expected})`);
            }
        }

        return steps.join("\n");
    }
}
