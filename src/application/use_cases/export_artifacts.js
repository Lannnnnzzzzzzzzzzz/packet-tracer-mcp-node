// Use case: export artifacts to disk. (Port of application/use_cases/export_artifacts.py)

import { ManualExecutor } from "../../infrastructure/execution/manual_executor.js";
import { ExportResponse } from "../dto/responses.js";

export function export_artifacts_uc(plan, output_dir = "projects") {
    /** Exports all files of the plan. */
    const executor = new ManualExecutor({ output_dir: output_dir });
    const result = executor.execute(plan);
    return new ExportResponse({
        status: result["status"],
        project_dir: result["project_dir"],
        files: result["files"],
    });
}
