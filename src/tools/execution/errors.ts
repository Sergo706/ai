/**
 * Thrown when the caller's `AbortSignal` fires mid-run.
 *
 * @example
 * ```ts
 * if (err instanceof RequestAbortedError) return;
 * ```
 */
export class RequestAbortedError extends Error {
  constructor() {
    super("Request aborted by the client.");
    this.name = "RequestAbortedError";
  }
}

/**
 * The error shown to a caller when a provider call could not be completed.
 *
 * Deliberately carries no provider detail, so nothing internal leaks into a
 * user-facing response.
 *
 * @returns A ready-to-throw error with a generic message.
 */
export function responseUnavailableError(): Error {
  return new Error("Unable to complete the response. Please try again.");
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RequestAbortedError();
}
