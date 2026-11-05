// Use case: automatically fix a plan. (Port of application/use_cases/fix_plan.py)

import { fix_plan } from "../../domain/services/auto_fixer.js";
import { validate_plan } from "../../domain/services/validator.js";
import { pyJsonDumps } from "../../shared/pycompat.js";
import { FixResponse } from "../dto/responses.js";

export function fix_plan_uc(plan) {
    /** Attempts to fix a plan automatically. */
    const [fixed_plan, fixes] = fix_plan(plan);
    const validation = validate_plan(fixed_plan);
    return new FixResponse({
        // Python: fixed_plan.model_dump_json(indent=2)
        plan_json: pyJsonDumps(fixed_plan.toDict(), { indent: 2, ensureAscii: false }),
        fixes_applied: fixes,
        is_valid: validation.is_valid,
        remaining_errors: validation.errors.map((e) => e.toDict()),
    });
}
