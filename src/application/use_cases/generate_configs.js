// Use case: generar configuraciones CLI. (Port of application/use_cases/generate_configs.py)

import { generate_all_configs } from "../../infrastructure/generator/cli_config_generator.js";

export function generate_configs_uc(plan) {
    /** Genera configuraciones CLI por dispositivo. */
    return generate_all_configs(plan);
}
