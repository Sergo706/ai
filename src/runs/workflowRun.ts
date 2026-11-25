import { Logger } from "../config/configSchema";
import { loadCheckpoint, saveCheckpoint } from "../models/runCheckpoint";
import {
  INSTANCE_ID,
  claimRun,
  finishRun,
  releaseRun,
  startLeaseHeartbeat,
} from "../models/runLease";
import { createRun, updateRun } from "../models/runs";
import { runWasAborted } from "./abortSignals";
import { isTransientError } from "./transientErrors";
import type {
  WorkflowExecution,
  WorkflowPayload,
  WorkflowRunContext,
  WorkflowRunOptions,
} from "./types";

/**
 * Run one long workflow through the shared lifecycle.
 *
 * Creates (or re-claims) the run row, keeps the lease heartbeated while
 * `execute` works, records the terminal status, and releases the lease. A
 * transient failure with a checkpoint is recorded as `interrupted` so the
 * recovery sweep can resume it.
 *
 * @param options - The run's identity, query and progress callback.
 * @param execute - The work itself, given a context with the lease signal and
 * checkpoint helpers.
 * @param log - Logger for lifecycle lines.
 * @returns The payload envelope for the route, once the run finishes.
 * @throws The error from `execute`, after the row has been updated.
 * @example
 * ```ts
 * const payload = await runWorkflow(
 *   { kind: "workflow", name: "research", query },
 *   async (ctx) => runResearch(ctx),
 *   logger,
 * );
 * ```
 */
export async function runWorkflow<TData>(
  options: WorkflowRunOptions,
  execute: (ctx: WorkflowRunContext) => Promise<WorkflowExecution<TData>>,
  log: Logger,
): Promise<WorkflowPayload<TData>> {
  const {
    kind,
    name,
    query,
    userId,
    conversationId,
    signal,
    onRunStarted,
    resumeRunId,
  } = options;

  const runId = resumeRunId ?? options.runId ?? crypto.randomUUID();
  let stopHeartbeat: (() => void) | undefined;
  const lease = { aborted: false, terminated: false };
  const controller = new AbortController();

  let owns = false;

  try {
    if (resumeRunId) {
      const claimed = await claimRun(runId);
      if (!claimed) {
        throw new Error(`Run ${runId} is already owned by another process`);
      }
    } else {
      await createRun({
        id: runId,
        kind,
        query,
        userId: userId ?? null,
        conversationId: conversationId ?? null,
        // `name` is omitted rather than written as `undefined`: a kind with a
        // single runner has no name, and must not carry a key whose absence is
        // what routes the row to that runner on resume.
        input:
          name === undefined
            ? { ...options.input }
            : { name, ...options.input },
      });
      await claimRun(runId);
    }
    owns = true;

    onRunStarted?.(runId);

    stopHeartbeat = startLeaseHeartbeat(
      runId,
      (state) => {
        if (state === "aborted") {
          lease.aborted = true;
          log.info(
            { runId },
            "[workflow] Abort requested from another replica; stopping",
          );
        } else {
          lease.terminated = true;
          log.warn(
            { runId, leaseState: state },
            "[workflow] Lease closed elsewhere; stopping without recording",
          );
        }
        controller.abort();
      },
      log,
    );

    const merged = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    const execution = await execute({
      runId,
      leaseSignal: merged,
      saveCheckpoint: (snapshot) => {
        void saveCheckpoint({ runId, snapshot });
      },
      loadCheckpoint: () => loadCheckpoint(runId),
      emitProgress: (event) => options.onProgress?.(event),
    });

    await finishRun({
      runId,
      stopReason: execution.stopReason,
      partial: {
        report: execution.data,
        isSufficient: execution.isSufficient,
        missingIntents: execution.missingSearchTerms,
      },
    });

    return {
      success: true,
      source: execution.source,
      promptId: execution.promptId,
      generatedDocumentIds: execution.generatedDocumentIds,
      isSufficient: execution.isSufficient,
      stopReason: execution.stopReason,
      missingSearchTerms: execution.missingSearchTerms,
      urls: execution.urls,
      data: execution.data,
    };
  } catch (err) {
    const aborted = runWasAborted({
      error: err,
      signal,
      leaseAborted: lease.aborted,
    });
    const transient = aborted ? false : isTransientError(err);

    log.error(
      { err, aborted, transient },
      aborted ? "Workflow aborted" : "Server error",
    );

    if (lease.aborted || lease.terminated) {
      await releaseRun(runId).catch(() => {
        // The row is already in its final state written by the other replica.
      });
      throw err;
    }

    // Nothing was claimed, so there is no row of ours to correct. Writing here
    // would either fail on a foreign row or, worse, mark a run another replica
    // is actively executing as `failed`.
    if (!owns) {
      throw err;
    }

    const resumable =
      transient && (await loadCheckpoint(runId).catch(() => null)) !== null;

    await updateRun({
      id: runId,
      status: aborted ? "aborted" : resumable ? "interrupted" : "failed",
      error: err instanceof Error ? err.message : String(err),
      finished: true,
      owner: INSTANCE_ID,
    }).catch(() => {
      // A failed bookkeeping write must not mask the original error.
    });

    throw err;
  } finally {
    stopHeartbeat?.();
    await releaseRun(runId).catch(() => {
      // Cleanup must never mask the real outcome.
    });
  }
}
