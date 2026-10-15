/**
 * Runs operations through an operation guard, which can enforce policies such as
 * retries, circuit breaking, or fail-fast behavior.
 */
export interface OperationGuard {
  run<R>(operation: () => Promise<R>): Promise<R>;
}
