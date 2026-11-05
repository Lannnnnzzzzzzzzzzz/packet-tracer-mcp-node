// Use case: generar script PTBuilder. (Port of application/use_cases/generate_script.py)

import {
    generate_ptbuilder_script,
    generate_full_script,
} from "../../infrastructure/generator/ptbuilder_generator.js";

export function generate_script_uc(plan, include_configs = true) {
    /** Genera el script PTBuilder. */
    if (include_configs) {
        return generate_full_script(plan);
    }
    return generate_ptbuilder_script(plan);
}
