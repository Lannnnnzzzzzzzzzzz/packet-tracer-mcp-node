// Use case: validar plan. (Port of application/use_cases/validate_plan.py)

import { validate_plan } from "../../domain/services/validator.js";
import { ValidationResponse } from "../dto/responses.js";

export function validate_plan_uc(plan) {
    /** Valida un plan y retorna resultado. */
    const result = validate_plan(plan);
    return new ValidationResponse({
        is_valid: result.is_valid,
        errors: result.errors.map((e) => e.toDict()),
        warnings: result.warnings.map((w) => w.toDict()),
    });
}
