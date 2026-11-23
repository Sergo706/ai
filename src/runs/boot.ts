import { getConfiguration } from "../config/config";
import { INSTANCE_ID, markStaleRunsInterrupted } from "../models/runLease";
import { listRunResumers } from "./resumerRegistry";
import { startRunRecovery } from "./runRecovery";

/**
 * Starts the parts of the run subsystem that outlive a single request.
 *
 * Call this once per process, after `configuration()`. It returns the stop
 * function the host wires into its own shutdown path — a plugin `dispose` hook,
 * an `app.on("close")`, a signal handler. That is the whole of the framework
 * coupling: the host decides *when*, this module decides *what*.
 *
 */
export function startRuns(): () => void {
  const log = getConfiguration().logger;
  let stop: (() => void) | undefined;

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

    const kinds = listRunResumers().map((r) => r.kind);
    log.info(
      { instance: INSTANCE_ID, kinds },
      "[runs] Recovery sweeper started",
    );

    stop = startRunRecovery();
  })();

  return () => {
    stop?.();
  };
}
