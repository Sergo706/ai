
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name.endsWith("AbortedError");
}


export function runWasAborted(args: {
  error?: unknown;
  signal?: AbortSignal;
  leaseAborted?: boolean;
}): boolean {
  if (args.leaseAborted === true) return true;
  if (args.signal?.aborted === true) return true;
  return isAbortError(args.error);
}
