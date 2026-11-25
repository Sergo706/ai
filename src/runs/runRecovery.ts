import { envInt } from "@riavzon/utils/server";
import { findRunResumer, listRunResumers } from "./resumerRegistry";
import {
  findResumableRuns,
  getLeaseTtlMs,
  INSTANCE_ID,
} from "../models/runLease";
import { updateRun } from "../models/runs";
import { getConfiguration } from "../config/config";
import { fromJson } from "../db/utils";

const recoveryConfig = () => getConfiguration().runs.recovery;

function getSweepIntervalMs(): number {
  return envInt(
    "RUNS_SWEEP_INTERVAL_MS",
    recoveryConfig().sweepIntervalMs ||
      Math.max(1_000, Math.floor(getLeaseTtlMs() / 2)),
    {
      min: 100,
    },
  );
}

function getMaxAdoptPerSweep(): number {
  return envInt(
    "RUNS_MAX_ADOPT_PER_SWEEP",
    recoveryConfig().maxAdoptPerSweep,
    { min: 1 },
  );
}

/**
 * How many times one run may be resumed after its owner died.
 *
 * Enforced by both the sweep and `retryRun`, so a manual retry cannot resume a
 * run the sweep already gave up on.
 *
 * @default config.runs.recovery.maxResumeAttempts
 */
export function getMaxResumeAttempts(): number {
  return envInt(
    "RUNS_MAX_RESUME_ATTEMPTS",
    recoveryConfig().maxResumeAttempts,
    { min: 0 },
  );
}

function getUnclaimedGraceMs(): number {
  return envInt(
    "RUNS_UNCLAIMED_GRACE_MS",
    recoveryConfig().unclaimedGraceMs,
    { min: 0 },
  );
}

let sweeping = false;

/** The settings the recovery sweep runs with, resolved lazily from config/env. */
export function getRunRecoverySettings(): {
  sweepIntervalMs: number;
  maxAdoptPerSweep: number;
  maxResumeAttempts: number;
  unclaimedGraceMs: number;
} {
  return {
    sweepIntervalMs: getSweepIntervalMs(),
    maxAdoptPerSweep: getMaxAdoptPerSweep(),
    maxResumeAttempts: getMaxResumeAttempts(),
    unclaimedGraceMs: getUnclaimedGraceMs(),
  };
}

function parseRunInput(raw: unknown): { name?: string } {
  const parsed = fromJson<unknown>(raw);
  return parsed !== null && typeof parsed === "object"
    ? (parsed)
    : {};
}

/**
 * Adopts runs whose owner stopped renewing its lease.
 *
 * This function is a scheduler and nothing else. It knows how to find an
 * abandoned row, how to give up on a poison run, and how to hand a row to
 * whoever registered for its `kind` — it knows nothing about research, seeds,
 * phases or SERP calls. Everything kind-specific lives in
 * `server/lib/runs/resumers/`, so adding a workflow never edits this file.
 *
 * Two things make it safe with several replicas:
 *
 * 1. `findResumableRuns` only returns rows nobody is working on — a `running`
 *    row whose lease expired, or an `interrupted` row a transient failure left
 *    with a checkpoint — so a live run is never a candidate.
 * 2. Every resumer re-claims the row before doing any work, and the claim is a
 *    conditional `UPDATE`. If two replicas race, one gets the row and the other
 *    is refused without spending a cent.
 *
 * Chat is deliberately never registered. A chat turn is short, its cost is
 * mostly already cached, and replaying a tool round can duplicate an assistant
 * message or regenerate a PDF. Retrying from the UI is the correct answer.
 */
async function sweepOnce(): Promise<void> {
  const log = getConfiguration().logger;
  if (sweeping) return;
  sweeping = true;

  try {
    const registered = listRunResumers();
    if (registered.length === 0) {
      // Nothing can be resumed, so there is no reason to poll the database.
      log.debug("[runs] No run resumers registered; skipping sweep");
      return;
    }

    const settings = getRunRecoverySettings();
    for (const kind of new Set(registered.map((r) => r.kind))) {
      const candidates = await findResumableRuns(settings.maxAdoptPerSweep, kind);
      if (candidates.length === 0) continue;

      log.warn(
        { count: candidates.length, kind, instance: INSTANCE_ID },
        "[runs] Found abandoned runs; attempting to adopt",
      );

      for (const row of candidates) {
        const input = parseRunInput(row.input);
        const resumer = findRunResumer(row.kind, input.name);
        if (!resumer) {
          const abandonedSince = row.claimed_at ?? row.started_at;
          const ageMs = Date.now() - new Date(abandonedSince).getTime();
          if (ageMs < settings.unclaimedGraceMs) {
            log.debug(
              {
                runId: row.id,
                kind: row.kind,
                name: input.name ?? null,
                ageMs,
              },
              "[runs] No resumer for this row yet; leaving it for a pending rollout",
            );
            continue;
          }

          await updateRun({
            id: row.id,
            status: "failed",
            error: `No runner is registered for ${row.kind} name "${input.name ?? ""}"`,
            finished: true,
          }).catch(() => {
            // Best effort: the sweep must not stop because one write failed.
          });
          log.error(
            { runId: row.id, kind: row.kind, name: input.name ?? null, ageMs },
            "[runs] Closed a run that no build could resume",
          );
          continue;
        }

        if (row.attempts >= settings.maxResumeAttempts) {
          await updateRun({
            id: row.id,
            status: "failed",
            error: "Run abandoned after repeated resume attempts",
            finished: true,
          }).catch(() => {
            // Best effort: the sweep must not stop because one write failed.
          });
          log.error(
            { runId: row.id, kind: row.kind, attempts: row.attempts },
            "[runs] Gave up resuming a run that keeps dying",
          );
          continue;
        }

        log.warn(
          {
            runId: row.id,
            kind: row.kind,
            name: resumer.name ?? null,
            attempts: row.attempts,
          },
          "[runs] Resuming an abandoned run",
        );
        await resumer.adopt(row).catch((err: unknown) => {
          log.error({ err, runId: row.id }, "[runs] Resume attempt failed");
        });
      }
    }
  } catch (err) {
    log.error({ err }, "[runs] Recovery sweep failed");
  } finally {
    sweeping = false;
  }
}

/**
 * Start the background sweeper that adopts abandoned runs.
 *
 * A single replica runs this fine; with several, the conditional claim means
 * only one does the work. Resumers register themselves when their module is
 * imported, so nothing is registered here.
 *
 * @returns A stop function; call it from your shutdown path.
 * @example
 * ```ts
 * const stopRecovery = startRunRecovery();
 * ```
 */
export function startRunRecovery(): () => void {
  void sweepOnce();
  const timer = setInterval(() => {
    void sweepOnce();
  }, getSweepIntervalMs());
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
