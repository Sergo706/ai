/** Thrown when the caller's AbortSignal fires mid-run. */
export class RequestAbortedError extends Error {
  constructor() {
    super("Request aborted by the client.");
    this.name = "RequestAbortedError";
  }
}

/** Safe to surface; deliberately excludes the raw provider error and cause. */
export function responseUnavailableError(): Error {
  return new Error("Unable to complete the response. Please try again.");
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RequestAbortedError();
}
