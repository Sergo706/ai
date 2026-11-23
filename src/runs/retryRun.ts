import { getConfiguration } from "../config/config";
import { reopenRunForRetry } from "../models/runLease";
import { getRunById } from "../models/runs";
import { StoredRun } from "../types/RunModel";
import { findRunResumer } from "./resumerRegistry";
import { MAX_RESUME_ATTEMPTS } from "./runRecovery";
import { getRun } from "./runRegistry";
import type { RetryOutcome } from "./types";



function workflowName(row: StoredRun): string | undefined {
  const input = (row.input ?? {}) as { name?: string };
  return input.name;
}

/**
 * Puts a closed run back to work at the user's request.
 *
 * This is the manual counterpart to the recovery sweep. The sweep only adopts
 * rows that look abandoned; this one runs when a person asks, so it accepts
 * `aborted` and `failed` as well — the two statuses the sweep deliberately
 * never touches.
 *
 * The checkpoint is kept. A run with a snapshot continues from its last round
 * boundary, and one without starts over; the response reports which happened so
 * the caller can tell the difference before it starts waiting.
 *
 * `attempts` is incremented by this call and is **not** reset, which is what
 * makes the cap meaningful for manual retries too. When the cap is already
 * reached the run is not reopened: repeating a run that keeps dying produces the
 * same death, so the answer is a new run with a new id.
 */
export async function retryRun(runId: string): Promise<RetryOutcome> {
  const log = getConfiguration().logger;
  const row = await getRunById(runId);
  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      message: `No run with id ${runId}`,
    };
  }

  const name = workflowName(row);
  const resumer = findRunResumer(row.kind, name);
  if (!resumer) {
    return {
      ok: false,
      reason: "no_runner",
      message:
        name === undefined
          ? `No runner is registered for kind "${row.kind}"`
          : `No runner is registered for kind "${row.kind}" name "${name}"`,
      status: row.status,
    };
  }

  if (row.status === "running") {
    const live = getRun(runId);
    return {
      ok: false,
      reason: "already_running",
      message:
        live === undefined
          ? "The run is still marked running; the recovery sweep owns stale rows and will resume it"
          : "The run is executing on this replica right now",
      status: row.status,
    };
  }

  if (row.attempts >= MAX_RESUME_ATTEMPTS) {
    return {
      ok: false,
      reason: "attempts_exhausted",
      message: `This run has already used all ${String(MAX_RESUME_ATTEMPTS)} resumes. Start a new run instead of retrying this one.`,
      status: row.status,
      attempts: row.attempts,
    };
  }

  const reopened = await reopenRunForRetry(runId);
  if (!reopened) {
    // Something changed the row between the read above and this write: either
    // another replica claimed it or it finished. Report the current state rather
    // than pretending the retry succeeded.
    const current = await getRunById(runId);
    return {
      ok: false,
      reason: "already_running",
      message: "The run changed state before it could be reopened; try again",
      status: current?.status,
      attempts: current?.attempts,
    };
  }

  const resumed = reopened.checkpoint !== null;
  log.warn(
    {
      runId,
      kind: row.kind,
      name: name ?? null,
      status: row.status,
      attempts: reopened.attempts,
      resumed,
    },
    "[runs] Retrying a run on request",
  );

  void resumer.adopt(reopened).catch((err: unknown) => {
    log.error({ err, runId }, "[runs] Manual retry failed");
  });

  return {
    ok: true,
    runId,
    kind: row.kind,
    name: name ?? null,
    resumed,
    attempts: reopened.attempts,
  };
}
