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
 * Restart a closed run at the user's request.
 *
 * Accepts `aborted` and `failed` runs, which the recovery sweep never touches.
 * A checkpoint is kept: a run that has one continues from its last round, and
 * one that does not starts over. `outcome.resumed` says which happened.
 *
 * @param runId - The run to restart.
 * @returns `ok: true` with the run's details, or `ok: false` with the reason.
 * @example
 * ```ts
 * const outcome = await retryRun(runId);
 * if (!outcome.ok) return badRequest(outcome.message);
 * ```
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
