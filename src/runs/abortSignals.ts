
/**
 * `true` when an error means the work was cancelled.
 *
 * Recognises `AbortError` and the package's own `*AbortedError` names.
 *
 * @param err - The thrown value.
 */
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name.endsWith("AbortedError");
}


/**
 * Decide whether a run should be recorded as aborted rather than failed.
 *
 * @param args - The thrown error, the caller's signal, and whether the lease
 * heartbeat saw an abort.
 * @returns `true` when any of them says the run was cancelled.
 */
export function runWasAborted(args: {
  error?: unknown;
  signal?: AbortSignal;
  leaseAborted?: boolean;
}): boolean {
  if (args.leaseAborted === true) return true;
  if (args.signal?.aborted === true) return true;
  return isAbortError(args.error);
}
