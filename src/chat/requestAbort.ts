import { getConfiguration } from "../config/config";

/** Tracks whether the caller aborted the request. */
export interface RequestAbort {
  /** Pass to the turn; fires when the client disconnects. */
  signal: AbortSignal;
  /** Abort the turn programmatically. */
  abort(): void;
  /** Stop honouring aborts; call once the turn has completed. */
  markFinished(): void;
}

/** Optional behaviour for a client that disconnects mid-stream. */
export interface RequestAbortOptions {
  /** Anything identifying the request, for the disconnect log line. */
  meta?: Record<string, unknown>;
  /**
   * Register the disconnect handler. The callback you are given aborts the
   * turn; call it from your HTTP layer when the client goes away.
   */
  onDisconnect?: (cancel: () => void) => void;
}

/**
 * Create an abort tracker for one request.
 *
 * @param options - Disconnect logging and handler.
 * @returns The signal to pass into the turn, plus `abort()` to cancel it and
 * `markFinished()` to ignore aborts that arrive after the turn completed.
 * @example
 * ```ts
 * const abort = createRequestAbort({ onDisconnect: (cancel) => req.on("close", cancel) });
 * await agent.chat({ message, signal: abort.signal });
 * abort.markFinished();
 * ```
 */
export function createRequestAbort(
  options: RequestAbortOptions = {},
): RequestAbort {
  const controller = new AbortController();
  const log = getConfiguration().logger;
  let finished = false;

  options.onDisconnect?.(() => {
    if (finished) return;
    log.warn({ ...options.meta }, "Client disconnected during stream");
    controller.abort();
  });

  return {
    signal: controller.signal,
    abort: () => {
      controller.abort();
    },
    markFinished: () => {
      finished = true;
    },
  };
}
