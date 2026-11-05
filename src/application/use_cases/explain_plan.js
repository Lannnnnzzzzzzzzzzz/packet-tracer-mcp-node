// Use case: explicar plan. (Port of application/use_cases/explain_plan.py)

import { explain_plan } from "../../domain/services/explainer.js";

export function explain_plan_uc(plan) {
    /** Genera explicaciones del plan. */
    return explain_plan(plan);
}
