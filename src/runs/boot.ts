import { getConfiguration } from "../config/config";
import { INSTANCE_ID, markStaleRunsInterrupted } from "../models/runLease";
import { listRunResumers } from "./resumerRegistry";
import { startRunRecovery } from "./runRecovery";

/**
 * Start the parts of the run subsystem that outlive a single request.
 *
 * Call once per process, after `configuration()`. It closes stale runs left by a
 * previous process and starts the recovery sweep.
 *
 * @returns A stop function; call it from your shutdown path.
 * @example
 * ```ts
 * const stopRuns = startRuns();
 * process.on("SIGTERM", () => stopRuns());
 * ```
 */
export function startRuns(): () => void {
  const log = getConfiguration().logger;
  let stop: (() => void) | undefined;
  let stopped = false;

  void (async () => {
    try {
      const count = await markStaleRunsInterrupted();
      if (count > 0) {
        log.warn(
          { count, instance: INSTANCE_ID },
          "[runs] Marked abandoned runs as interrupted",
        );
      }
    } catch (err) {
      log.error({ err }, "[runs] Could not reconcile interrupted runs");
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (stopped) return;

    const kinds = listRunResumers().map((r) => r.kind);
    log.info(
      { instance: INSTANCE_ID, kinds },
      "[runs] Recovery sweeper started",
    );

    stop = startRunRecovery();
  })();

  return () => {
    stopped = true;
    stop?.();
  };
}
