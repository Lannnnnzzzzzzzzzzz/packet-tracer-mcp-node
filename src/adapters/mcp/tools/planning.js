// Offline planning tools: catalog, estimate, plan, validate, fix, explain, generate, export, projects.
// (Port of adapters/mcp/tools/planning.py)

import { TopologyPlan } from "../../../domain/models/plans.js";
import { TopologyRequest } from "../../../domain/models/requests.js";
import { plan_from_request } from "../../../domain/services/orchestrator.js";
import { validate_plan } from "../../../domain/services/validator.js";
import { fix_plan } from "../../../domain/services/auto_fixer.js";
import { explain_plan } from "../../../domain/services/explainer.js";
import { estimate_from_request } from "../../../domain/services/estimator.js";
import {
    generate_ptbuilder_script,
    generate_full_script,
} from "../../../infrastructure/generator/ptbuilder_generator.js";
import {
    generate_all_configs,
    generate_pc_config,
} from "../../../infrastructure/generator/cli_config_generator.js";
import { ManualExecutor } from "../../../infrastructure/execution/manual_executor.js";
import { DeployExecutor } from "../../../infrastructure/execution/deploy_executor.js";
import { ProjectRepository } from "../../../infrastructure/persistence/project_repository.js";
import { ALL_MODELS, ALL_MODELS_ORDER, resolve_model } from "../../../infrastructure/catalog/devices.js";
import { MODEL_ALIASES, MODEL_ALIASES_ORDER } from "../../../infrastructure/catalog/aliases.js";
import { list_templates } from "../../../infrastructure/catalog/templates.js";
import { RoutingProtocol, TopologyTemplate, enumByValue } from "../../../shared/enums.js";
import { pyJsonDumps, pyTruthy } from "../../../shared/pycompat.js";
import { read_plan_source, reply_json, workdir_subdir } from "../../../shared/utils.js";

// Python `RoutingProtocol(value)` / `TopologyTemplate(value)`: the string
// itself when valid, a ValueError with CPython's message when not.
function _routing_protocol(value) {
    const v = enumByValue(RoutingProtocol, value);
    if (v === undefined) {
        throw new Error(`'${value}' is not a valid RoutingProtocol`);
    }
    return v;
}

function _topology_template(value) {
    const v = enumByValue(TopologyTemplate, value);
    if (v === undefined) {
        throw new Error(`'${value}' is not a valid TopologyTemplate`);
    }
    return v;
}

// Python `plan.model_dump_json()`: pydantic's compact JSON (raw UTF-8).
function _plan_dump_json(plan) {
    if (typeof plan.model_dump_json === "function") return plan.model_dump_json();
    if (typeof plan.modelDumpJson === "function") return plan.modelDumpJson();
    if (typeof plan.toJson === "function") return plan.toJson();
    return pyJsonDumps(plan.toDict(), { ensureAscii: false, separators: [",", ":"] });
}

// Python `TopologyPlan.model_validate_json(text)`.
function _plan_validate_json(text) {
    if (typeof TopologyPlan.model_validate_json === "function") return TopologyPlan.model_validate_json(text);
    if (typeof TopologyPlan.modelValidateJson === "function") return TopologyPlan.modelValidateJson(text);
    if (typeof TopologyPlan.fromJson === "function") return TopologyPlan.fromJson(text);
    return new TopologyPlan(JSON.parse(text));
}

// Entries of a catalog/config mapping, whether the port kept it a plain
// object or a Map (Python dicts preserve insertion order; JS objects
// reorder integer-like keys, which device model names are).
function _entries(obj) {
    return obj instanceof Map ? [...obj.entries()] : Object.entries(obj);
}

export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */

    // ------------------------------------------------------------------
    // QUERY
    // ------------------------------------------------------------------
    registry.tool("pt_list_devices", async (args = {}) => {
        const lines = [];
        for (const [name, model] of ALL_MODELS_ORDER.map((n) => [n, ALL_MODELS[n]])) {
            const ports = model.ports.map((p) => p.full_name).join(", ");
            lines.push(`**${model.display_name}** (type: \`${name}\`, category: ${model.category})`);
            lines.push(`  Ports: ${ports}`);
            lines.push("");
        }
        lines.push("**Available aliases:**");
        for (const [alias, target] of MODEL_ALIASES_ORDER.map((a) => [a, MODEL_ALIASES[a]])) {
            lines.push(`  ${alias} → ${target}`);
        }
        return lines.join("\n");
    });

    registry.tool("pt_list_templates", async (args = {}) => {
        const templates = list_templates();
        const lines = [];
        for (const t of templates) {
            lines.push(`**${t.name}** (key: \`${t.key}\`)`);
            lines.push(`  ${t.description}`);
            lines.push(`  Routers: ${t.min_routers}-${t.max_routers} (default: ${t.default_routers})`);
            lines.push(`  PCs/LAN: ${t.default_pcs_per_lan}  |  WAN: ${t.requires_wan ? "yes" : "no"}`);
            lines.push(`  Routing: ${t.default_routing}`);
            lines.push(`  Tags: ${[...t.tags].join(", ")}`);
            lines.push("");
        }
        return lines.join("\n");
    });

    registry.tool("pt_get_device_details", async (args = {}) => {
        const { model_name } = args;
        const model = resolve_model(model_name);
        if (!model) {
            return `Model '${model_name}' not found. Use pt_list_devices to see the models.`;
        }
        const info = {
            "display_name": model.display_name,
            "category": model.category,
            "ports": model.ports.map((p) => ({
                "name": p.full_name,
                "speed": p.speed ? p.speed : "N/A",
            })),
            "total_ports": model.ports.length,
        };
        return reply_json(info);
    });

    // ------------------------------------------------------------------
    // ESTIMATION (dry-run)
    // ------------------------------------------------------------------
    registry.tool("pt_estimate_plan", async (args = {}) => {
        const {
            routers = 2,
            pcs_per_lan = 3,
            laptops_per_lan = 0,
            switches_per_router = 1,
            servers = 0,
            access_points = 0,
            has_wan = false,
            dhcp = true,
            routing = "static",
        } = args;
        const request = new TopologyRequest({
            routers: routers,
            pcs_per_lan: pcs_per_lan,
            laptops_per_lan: laptops_per_lan,
            switches_per_router: switches_per_router,
            servers: servers,
            access_points: access_points,
            has_wan: has_wan,
            dhcp: dhcp,
            routing: _routing_protocol(routing),
        });
        const est = estimate_from_request(request);
        return reply_json(est);
    });

    // ------------------------------------------------------------------
    // PLANNING
    // ------------------------------------------------------------------
    registry.tool("pt_plan_topology", async (args = {}) => {
        const {
            routers = 2,
            pcs_per_lan = 3,
            laptops_per_lan = 0,
            switches_per_router = 1,
            servers = 0,
            access_points = 0,
            has_wan = false,
            dhcp = true,
            routing = "static",
            router_model = "2911",
            switch_model = "2960-24TT",
            template = "multi_lan",
            floating_routes = false,
            ospf_process_id = 1,
            eigrp_as = 100,
            vlans = 0,
            dual_stack = false,
            ipv6_base = "2001:db8::/32",
            wireless_laptops = false,
        } = args;
        const request = new TopologyRequest({
            template: _topology_template(template),
            routers: routers,
            pcs_per_lan: pcs_per_lan,
            laptops_per_lan: laptops_per_lan,
            switches_per_router: switches_per_router,
            servers: servers,
            access_points: access_points,
            has_wan: has_wan,
            dhcp: dhcp,
            routing: _routing_protocol(routing),
            router_model: router_model,
            switch_model: switch_model,
            floating_routes: floating_routes,
            ospf_process_id: ospf_process_id,
            eigrp_as: eigrp_as,
            vlans: vlans,
            dual_stack: dual_stack,
            ipv6_base: ipv6_base,
            wireless_laptops: wireless_laptops,
        });
        const size = await ctx.canvas_size();
        if (pyTruthy(size)) {
            request.canvas_width = size[0];
            request.canvas_height = size[1];
        }
        const [plan, validation] = plan_from_request(request);
        return _plan_dump_json(plan);
    });

    // ------------------------------------------------------------------
    // VALIDATION
    // ------------------------------------------------------------------
    registry.tool("pt_validate_plan", async (args = {}) => {
        let { plan_json = "", plan_path = "" } = args;
        try {
            plan_json = read_plan_source(plan_json, plan_path);
        } catch (exc) {
            return reply_json({ "valid": false, "error_count": 1, "warning_count": 0,
                               "errors": [{ "code": "INVALID_PLAN_SOURCE", "message": exc.message }],
                               "warnings": [], "summary": `❌ ${exc.message}` });
        }
        let raw;
        try {
            raw = JSON.parse(plan_json);
        } catch (exc) {
            return reply_json({
                "valid": false,
                "error_count": 1,
                "warning_count": 0,
                "errors": [{ "code": "INVALID_JSON", "message": `Invalid JSON: ${exc.message}` }],
                "warnings": [],
                "summary": "❌ Invalid JSON — the plan could not be parsed.",
            });
        }

        if (raw === null || typeof raw !== "object" || Array.isArray(raw)
            || !("devices" in raw) || !pyTruthy(raw["devices"])) {
            return reply_json({
                "valid": false,
                "error_count": 1,
                "warning_count": 0,
                "errors": [{
                    "code": "EMPTY_PLAN",
                    "message": "The JSON does not contain a valid plan ('devices' is missing or empty). Generate the plan with pt_plan_topology first.",
                }],
                "warnings": [],
                "summary": "❌ Empty or unstructured plan — it must include at least one device.",
            });
        }

        const plan = _plan_validate_json(plan_json);
        const result = validate_plan(plan);

        const output = typeof result.to_dict === "function" ? result.to_dict() : result.toDict();
        if (result.is_valid) {
            output["summary"] = "✅ Valid plan. No errors.";
        } else {
            output["summary"] = `❌ Plan with ${result.errors.length} error(s).`;
        }
        return reply_json(output);
    });

    // ------------------------------------------------------------------
    // AUTO-FIX
    // ------------------------------------------------------------------
    registry.tool("pt_fix_plan", async (args = {}) => {
        const { plan_json } = args;
        const plan = _plan_validate_json(plan_json);
        const [fixed_plan, fixes] = fix_plan(plan);

        return reply_json({
            "fixes_applied": fixes,
            "fixes_count": fixes.length,
            "is_valid": fixed_plan.is_valid,
            "plan": JSON.parse(_plan_dump_json(fixed_plan)),
        });
    });

    // ------------------------------------------------------------------
    // EXPLANATION
    // ------------------------------------------------------------------
    registry.tool("pt_explain_plan", async (args = {}) => {
        const { plan_json } = args;
        const plan = _plan_validate_json(plan_json);
        const explanations = explain_plan(plan);
        return explanations.map((e) => `• ${e}`).join("\n");
    });

    // ------------------------------------------------------------------
    // GENERATION
    // ------------------------------------------------------------------
    registry.tool("pt_generate_script", async (args = {}) => {
        const { plan_json, include_configs = true } = args;
        const plan = _plan_validate_json(plan_json);
        if (include_configs) {
            return generate_full_script(plan);
        }
        return generate_ptbuilder_script(plan);
    });

    registry.tool("pt_generate_configs", async (args = {}) => {
        const { plan_json } = args;
        const plan = _plan_validate_json(plan_json);
        const configs = generate_all_configs(plan);

        const result_parts = [];
        for (const [device_name, cli_block] of _entries(configs)) {
            result_parts.push(`=== ${device_name} ===`);
            result_parts.push(cli_block);
            result_parts.push("");
        }

        const pcs = plan.devices.filter((d) => ["pc", "server", "laptop"].includes(d.category));
        if (pcs.length) {
            result_parts.push("=== Host configuration ===");
            const use_dhcp = pyTruthy(plan.dhcp_pools);
            for (const pc of pcs) {
                result_parts.push(generate_pc_config(pc, use_dhcp));
                result_parts.push("");
            }
        }

        return result_parts.join("\n");
    });

    // ------------------------------------------------------------------
    // EXPORT
    // ------------------------------------------------------------------
    registry.tool("pt_export", async (args = {}) => {
        const { plan_json, project_name = "topology", output_dir = "projects" } = args;
        const plan = _plan_validate_json(plan_json);
        const executor = new ManualExecutor(workdir_subdir(output_dir, "projects"));
        const result = executor.execute(plan, project_name);

        const lines = [
            `Files exported to ${result["project_dir"]}:`,
        ];
        for (const [key, path] of _entries(result["files"])) {
            lines.push(`  - ${key}: ${path}`);
        }
        return lines.join("\n");
    });

    // ------------------------------------------------------------------
    // DEPLOY (clipboard + instructions)
    // ------------------------------------------------------------------
    registry.tool("pt_deploy", async (args = {}) => {
        const { plan_json, project_name = "topology", output_dir = "projects" } = args;
        const plan = _plan_validate_json(plan_json);
        const executor = new DeployExecutor(workdir_subdir(output_dir, "projects"));
        const result = executor.execute(plan, project_name);

        const parts = [];

        if (result["clipboard"]) {
            parts.push("SCRIPT COPIED TO THE CLIPBOARD");
            parts.push("Paste it directly in Packet Tracer > Extensions > Scripting");
        } else {
            parts.push("FILES EXPORTED (could not copy to the clipboard)");
            parts.push(`Open ${result["project_dir"]}/topology.js and copy its contents`);
        }

        parts.push("");
        parts.push(`Project: ${result["project_dir"]}`);
        parts.push(`Devices: ${result["devices_count"]}`);
        parts.push(`Links: ${result["links_count"]}`);
        parts.push("");

        for (const [key, path] of _entries(result["files"])) {
            parts.push(`  ${key}: ${path}`);
        }

        parts.push("");
        parts.push(result["instructions"]);

        return parts.join("\n");
    });

    // ------------------------------------------------------------------
    // PROJECTS
    // ------------------------------------------------------------------
    registry.tool("pt_list_projects", async (args = {}) => {
        const { output_dir = "projects" } = args;
        const repo = new ProjectRepository(workdir_subdir(output_dir, "projects"));
        const projects = repo.list_projects();
        if (!projects.length) {
            return "There are no saved projects.";
        }
        return reply_json(projects);
    });

    registry.tool("pt_load_project", async (args = {}) => {
        const { project_name, output_dir = "projects" } = args;
        const repo = new ProjectRepository(workdir_subdir(output_dir, "projects"));
        const plan = repo.load_plan(project_name);
        return _plan_dump_json(plan);
    });
}
