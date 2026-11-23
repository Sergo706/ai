import { envInt } from "@riavzon/utils/server";
import { findRunResumer, listRunResumers } from "./resumerRegistry";
import { findResumableRuns, INSTANCE_ID, LEASE_TTL_MS } from "../models/runLease";
import { updateRun } from "../models/runs";
import { getConfiguration } from "../config/config";

const recoveryConfig = () => getConfiguration().runs.recovery;

/**
 * How often to look for abandoned runs.
 *
 * Defaults to half the lease, so a run is adopted somewhere between half a lease
 * and a full lease after its owner dies: fast enough that a crash is not
 * noticed a minute late, slow enough that a rolling deploy does not scan
 * constantly. Deriving it means changing the lease never leaves the sweep
 * looking too late or too eagerly; the env var is there for tests, which set a
 * sub-second lease and need the sweep to keep up.
 */
const SWEEP_INTERVAL_MS = envInt(
  "RUNS_SWEEP_INTERVAL_MS",
  recoveryConfig().sweepIntervalMs ||
    Math.max(1_000, Math.floor(LEASE_TTL_MS / 2)),
  {
    min: 100,
  },
);

/** How many runs one sweep will try to adopt, so a mass crash cannot stampede. */
const MAX_ADOPT_PER_SWEEP = envInt(
  "RUNS_MAX_ADOPT_PER_SWEEP",
  recoveryConfig().maxAdoptPerSweep,
  { min: 1 },
);

/**
 * How many times one run may be resumed after its owner died.
 *
 * `claimRun()` only increments `attempts` on a *takeover*, so a fresh run starts
 * at 0 and this number means exactly what its name says. Counting the original
 * claim as well would silently halve it.
 *
 * Exported because the manual retry route enforces the same cap. Two different
 * numbers here would let an endpoint resume a run the sweep had already given up
 * on.
 */
export const MAX_RESUME_ATTEMPTS = envInt(
  "RUNS_MAX_RESUME_ATTEMPTS",
  recoveryConfig().maxResumeAttempts,
  { min: 0 },
);

/**
 * How long a row with no registered runner is left `running` before it is closed.
 *
 * Without this the sweep would skip such a row on every pass and never write
 * anything, so the row would stay `running` indefinitely: a client reattached to
 * it would wait forever, and it would keep occupying one of
 * `RUNS_MAX_ADOPT_PER_SWEEP` slots that a real candidate needed.
 *
 * The grace period exists so a rolling deploy works. Boot the new build, its
 * sweep resolves the name, and the run resumes from its checkpoint — but only if
 * the old build has not already given up on it. Ten minutes covers a normal
 * rollout; set it to `0` to close orphans on the first pass.
 */
const UNCLAIMED_GRACE_MS = envInt(
  "RUNS_UNCLAIMED_GRACE_MS",
  recoveryConfig().unclaimedGraceMs,
  { min: 0 },
);

let sweeping = false;

export const RUN_RECOVERY_SETTINGS = {
  sweepIntervalMs: SWEEP_INTERVAL_MS,
  maxAdoptPerSweep: MAX_ADOPT_PER_SWEEP,
  maxResumeAttempts: MAX_RESUME_ATTEMPTS,
  unclaimedGraceMs: UNCLAIMED_GRACE_MS,
};

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

    for (const kind of new Set(registered.map((r) => r.kind))) {
      const candidates = await findResumableRuns(MAX_ADOPT_PER_SWEEP, kind);
      if (candidates.length === 0) continue;

      log.warn(
        { count: candidates.length, kind, instance: INSTANCE_ID },
        "[runs] Found abandoned runs; attempting to adopt",
      );

      for (const row of candidates) {
        const input = (row.input ?? {}) as { name?: string };
        const resumer = findRunResumer(row.kind, input.name);
        if (!resumer) {
          const abandonedSince = row.claimed_at ?? row.started_at;
          const ageMs = Date.now() - new Date(abandonedSince).getTime();
          if (ageMs < UNCLAIMED_GRACE_MS) {
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

        if (row.attempts >= MAX_RESUME_ATTEMPTS) {
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
 * Starts the background sweeper. Returns a stop function.
 *
 * A single replica runs this fine; with several, the conditional claim means
 * only one of them does the work and the rest find nothing to adopt.
 *
 * This function never registers anything. Resumers register themselves when
 * their module is imported, and `server/plugins/runsBoot.ts` is the one place
 * that imports them for that side effect. Keeping registration out of here is
 * what stops this file from growing a branch per workflow.
 */
export function startRunRecovery(): () => void {
  void sweepOnce();
  const timer = setInterval(() => {
    void sweepOnce();
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
