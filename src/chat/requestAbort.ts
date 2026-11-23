import { getConfiguration } from "../config/config";


export interface RequestAbort {
  signal: AbortSignal;
  abort(): void;
  markFinished(): void;
}

export interface RequestAbortOptions {
  /** Anything identifying the request, for the disconnect log line. */
  meta?: Record<string, unknown>;
  onDisconnect?: (cancel: () => void) => void;
}

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
    abort: () => { controller.abort(); },
    markFinished: () => {
      finished = true;
    },
  };
}