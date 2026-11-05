// Response DTOs for the application layer. (Port of application/dto/responses.py)

export class BuildResponse {
    /** Response of the full build. */
    constructor(obj = {}) {
        this.plan_json = obj.plan_json;
        this.script = obj.script;
        this.configs = obj.configs;
        this.validation = obj.validation;
        this.explanation = obj.explanation;
        this.estimation = obj.estimation;
        this.is_valid = obj.is_valid;
        this.errors = obj.errors === undefined ? [] : obj.errors;
        this.warnings = obj.warnings === undefined ? [] : obj.warnings;
    }

    toDict() {
        return {
            plan_json: this.plan_json,
            script: this.script,
            configs: this.configs,
            validation: this.validation,
            explanation: this.explanation,
            estimation: this.estimation,
            is_valid: this.is_valid,
            errors: this.errors,
            warnings: this.warnings,
        };
    }
}

export class ValidationResponse {
    /** Validation response. */
    constructor(obj = {}) {
        this.is_valid = obj.is_valid;
        this.errors = obj.errors;
        this.warnings = obj.warnings;
    }

    toDict() {
        return {
            is_valid: this.is_valid,
            errors: this.errors,
            warnings: this.warnings,
        };
    }
}

export class FixResponse {
    /** Fix response. */
    constructor(obj = {}) {
        this.plan_json = obj.plan_json;
        this.fixes_applied = obj.fixes_applied;
        this.is_valid = obj.is_valid;
        this.remaining_errors = obj.remaining_errors;
    }

    toDict() {
        return {
            plan_json: this.plan_json,
            fixes_applied: this.fixes_applied,
            is_valid: this.is_valid,
            remaining_errors: this.remaining_errors,
        };
    }
}

export class ExportResponse {
    /** Export response. */
    constructor(obj = {}) {
        this.status = obj.status;
        this.project_dir = obj.project_dir;
        this.files = obj.files;
    }

    toDict() {
        return {
            status: this.status,
            project_dir: this.project_dir,
            files: this.files,
        };
    }
}
