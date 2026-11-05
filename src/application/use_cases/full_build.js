// Use case: full build — plans, validates, generates and explains in a single step.
// (Port of application/use_cases/full_build.py)

import { BuildResponse } from "../dto/responses.js";
import { plan_topology } from "./plan_topology.js";
import { generate_full_script } from "../../infrastructure/generator/ptbuilder_generator.js";
import { generate_all_configs } from "../../infrastructure/generator/cli_config_generator.js";
import { explain_plan } from "../../domain/services/explainer.js";
import { estimate_from_plan } from "../../domain/services/estimator.js";
import { pyJsonDumps } from "../../shared/pycompat.js";

export function full_build(dto) {
    /** Runs the complete planning flow. */
    const [plan, validation] = plan_topology(dto);

    const script = generate_full_script(plan);
    const configs = generate_all_configs(plan);
    const explanation = explain_plan(plan);
    const estimation = estimate_from_plan(plan);

    return new BuildResponse({
        // Python: plan.model_dump_json(indent=2)
        plan_json: pyJsonDumps(plan.toDict(), { indent: 2, ensureAscii: false }),
        script: script,
        configs: configs,
        validation: validation.toDict(),
        explanation: explanation,
        estimation: estimation,
        is_valid: validation.is_valid,
        errors: validation.errors.map((e) => e.toDict()),
        warnings: validation.warnings.map((w) => w.toDict()),
    });
}
