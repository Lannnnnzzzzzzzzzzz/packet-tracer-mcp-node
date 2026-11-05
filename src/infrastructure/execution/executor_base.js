// Abstract base for topology executors.
// (Port of infrastructure/execution/executor_base.py)

export class ExecutorBase {
    /** Interface for executing a plan in Packet Tracer. */

    execute(plan, project_name = null) {
        /** Executes a plan and returns the result. */
        throw new Error("ExecutorBase.execute is abstract");
    }

    is_available() {
        /** Checks whether the executor is available. */
        throw new Error("ExecutorBase.is_available is abstract");
    }
}
