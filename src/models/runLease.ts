import { hostname } from "node:os";
import { sql, type Selectable } from "kysely";
import { envInt } from "@riavzon/utils/server";
import { getConfiguration, getDb } from "../config/config";
import type { RunKind, RunsTable } from "../db/schema";
import { timestamp, toJson } from "../db/utils";

/** A run kind, accepted by {@link findResumableRuns}. */
export type KindOf = RunKind;

/**
 * How long a claim stays valid without a heartbeat, in milliseconds.
 *
 * Read once at module load, so changing it means restarting the process.
 * Set `RUNS_LEASE_TTL_MS` to override; defaults to `config.runs.leaseTtlMs`.
 */
export const LEASE_TTL_MS = envInt(
  "RUNS_LEASE_TTL_MS",
  getConfiguration().runs.leaseTtlMs,
  { min: 5_000 },
);

/**
 * How often a live run refreshes its claim, in milliseconds.
 *
 * Clamped to half of {@link LEASE_TTL_MS}, so a misconfigured interval cannot
 * outlive the lease. Set `RUNS_HEARTBEAT_INTERVAL_MS` to override.
 */
export const HEARTBEAT_INTERVAL_MS = Math.min(
  envInt(
    "RUNS_HEARTBEAT_INTERVAL_MS",
    getConfiguration().runs.heartbeatIntervalMs,
    { min: 1_000 },
  ),
  Math.floor(LEASE_TTL_MS / 2),
);

/**
 * Identifies this process as a lease owner.
 *
 * Composed of hostname, pid and a random suffix, so two processes on the same
 * host never collide.
 */
export const INSTANCE_ID = `${detectHostname()}:${String(process.pid)}:${Math.random()
  .toString(36)
  .slice(2, 8)}`;

function detectHostname(): string {
  try {
    return hostname();
  } catch {
    return "unknown";
  }
}

/**
 * The instant before which a claim counts as abandoned. Every query that asks
 * "is this owner dead?" must use this, so boot reconciliation and the recovery
 * sweep can never disagree about what "abandoned" means for the same row.
 */
function staleCutoff(): string {
  return new Date(Date.now() - LEASE_TTL_MS).toISOString();
}

/**
 * Claim a run so only this process may work on it.
 *
 * Also reclaims a run whose previous owner stopped heartbeating.
 *
 * @param runId - The run to claim.
 * @returns `true` if the claim succeeded, `false` if someone else owns it.
 */
export async function claimRun(runId: string): Promise<boolean> {
  const staleBefore = staleCutoff();
  const claimed = await getDb()
    .updateTable("runs")
    .set({
      owner: INSTANCE_ID,
      claimed_at: timestamp(),
      // A claim counts as a *resume* in two cases, and neither is "the row has
      // no owner". A crashed run still has its dead owner recorded, and a
      // reconciled run has had its owner cleared — so checking `owner` alone
      // misses exactly half the resumes. The rule is: this is a resume unless
      // the row is untouched (`running` and never claimed by anyone).
      attempts: sql<number>`attempts + case when status = 'running' and owner is null then 0 else 1 end`,
      // A resumed row was closed (`interrupted`, or `failed` by an older build);
      // claiming it re-opens the run so `finishRun` can record the real outcome.
      status: "running",
      finished_at: null,
      error: null,
      stop_reason: null,
    })
    .where("id", "=", runId)
    // A `finished` or `aborted` row is a closed case. Without this guard a
    // released lease (`claimed_at` back to NULL) would let a stray claim
    // reopen a run the user or the system already saw end.
    .where("status", "in", ["running", "interrupted", "failed"])
    .where((eb) =>
      eb.or([
        eb("claimed_at", "is", null),
        eb("claimed_at", "<", staleBefore),
      ]),
    )
    .returning("id")
    .executeTakeFirst();
  return claimed !== undefined;
}

/**
 * Reopens a closed run because a person asked for it.
 *
 * Separate from `claimRun()` on purpose. `claimRun()` refuses `aborted` and
 * `finished` so that a stray claim after `releaseRun()` cannot resurrect a run
 * the user already saw end — and the recovery sweep relies on that refusal.
 * A manual retry is the opposite situation: the user is the one asking, and
 * `aborted` is one of the statuses they may want to undo.
 *
 * The lease is left **unclaimed**, so the runner claims it exactly the way the
 * sweep's runner does. Claiming here and again inside `adopt` would make the
 * second claim lose against the first, and every resumer would need a special
 * case for the retry path. Leaving it open also means a retry whose background
 * resume fails is still adoptable by the sweep.
 *
 * The update is conditional, so two retries racing produce one winner.
 * `attempts` is incremented, never reset, so the resume cap applies to manual
 * retries exactly as it applies to the sweep. The subsequent `claimRun()` adds
 * nothing, because a row that is `running` with no owner is not a takeover.
 *
 * @param runId - The run to reopen.
 * @returns The updated row, or `null` when the run cannot be reopened.
 */
export async function reopenRunForRetry(
  runId: string,
): Promise<Selectable<RunsTable> | null> {
  const reopened = await getDb()
    .updateTable("runs")
    .set({
      owner: null,
      claimed_at: null,
      attempts: sql<number>`attempts + 1`,
      status: "running",
      finished_at: null,
      error: null,
      stop_reason: null,
    })
    .where("id", "=", runId)
    .where("status", "in", ["interrupted", "failed", "aborted"])
    .returningAll()
    .executeTakeFirst();
  return reopened ?? null;
}

/**
 * What a heartbeat learned about the run it is renewing.
 *
 * `alive`      — the claim was renewed and the run is still `running`.
 * `aborted`    — the run was cancelled on purpose; unwind without writing.
 * `terminated` — the run already ended some other way (`failed`,
 *                `interrupted`, `finished`); stop and do not overwrite it.
 * `lost`       — another process took the claim and is now running it.
 * `gone`       — the row was deleted.
 */
export type LeaseState = "alive" | "aborted" | "terminated" | "lost" | "gone";

/**
 * Refreshes an existing claim and reports whether the run is still ours to run.
 *
 * This is also how a stop request reaches a run on another replica: the row is
 * set to `aborted`, and the owner notices on its next beat, so a stop takes at
 * most {@link HEARTBEAT_INTERVAL_MS}.
 *
 * @param runId - The run being worked on.
 * @returns `alive` to continue; any other value means stop and do not write.
 */
export async function heartbeatRun(runId: string): Promise<LeaseState> {
  const db = getDb();
  const refreshed = await db
    .updateTable("runs")
    .set({ claimed_at: timestamp() })
    .where("id", "=", runId)
    .where("owner", "=", INSTANCE_ID)
    .returning("status")
    .executeTakeFirst();

  if (refreshed !== undefined) {
    return refreshed.status === "running"
      ? "alive"
      : classifyOwnerStatus(refreshed.status);
  }

  // The claim is not ours any more. Distinguish "someone took over" from "the
  // run already ended", because the first means stop and the second means the
  // bookkeeping is done for us.
  const row = await db
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return "gone";
  return row.status === "running"
    ? "lost"
    : classifyOwnerStatus(row.status);
}

/**
 * Maps a terminal status on our own row to the instruction it implies.
 *
 * Only `aborted` is a user decision. Everything else was written by the harness
 * (`interrupted` at boot, `failed` by the recovery cap, `finished` by a
 * predecessor), and calling those "aborted" in the log would blame the user for
 * something they did not do.
 */
function classifyOwnerStatus(status: string): LeaseState {
  return status === "aborted" ? "aborted" : "terminated";
}

/**
 * Mark a run aborted, from any replica.
 *
 * The owning process notices on its next heartbeat and unwinds; the claim is
 * left in place so its checkpoint writes stay quiet during shutdown.
 *
 * @param runId - The run to stop.
 * @returns `true` when this call performed the cancellation.
 */
export async function requestAbort(runId: string): Promise<boolean> {
  const updated = await getDb()
    .updateTable("runs")
    .set({ status: "aborted", finished_at: timestamp(), error: null })
    .where("id", "=", runId)
    .where("status", "=", "running")
    .returning("id")
    .executeTakeFirst();
  return updated !== undefined;
}

/**
 * Record a successful finish.
 *
 * Will not overwrite a run that was cancelled meanwhile, so a late stop request
 * is never reported as success.
 *
 * @param args - The run id, its stop reason, and any partial output to keep.
 * @returns `true` when the finish was recorded.
 */
export async function finishRun(args: {
  runId: string;
  stopReason?: string | null;
  partial?: unknown;
}): Promise<boolean> {
  const updated = await getDb()
    .updateTable("runs")
    .set({
      status: "finished",
      stop_reason: args.stopReason ?? null,
      partial: toJson(args.partial),
      finished_at: timestamp(),
    })
    .where("id", "=", args.runId)
    .where("status", "=", "running")
    .returning("id")
    .executeTakeFirst();
  return updated !== undefined;
}

/**
 * Drop the claim so another replica may take the run over.
 *
 * Call on both success and failure paths.
 *
 * @param runId - The run whose lease to release.
 */
export async function releaseRun(runId: string): Promise<void> {
  await getDb()
    .updateTable("runs")
    .set({ owner: null, claimed_at: null })
    .where("id", "=", runId)
    .where("owner", "=", INSTANCE_ID)
    .execute();
}

/**
 * Keep a run's claim alive until it stops.
 *
 * @param runId - The run to keep claimed.
 * @param onStop - Called once when the run is no longer ours to work on.
 * @param log - Logger for the heartbeat and stop lines.
 * @returns A function that stops the heartbeat.
 * @example
 * ```ts
 * const stop = startLeaseHeartbeat(runId, () => controller.abort(), logger);
 * try { await work(); } finally { stop(); }
 * ```
 */
export function startLeaseHeartbeat(
  runId: string,
  onStop: (state: Exclude<LeaseState, "alive">) => void,
  log: {
    warn: (obj: unknown, msg: string) => void;
    debug: (obj: unknown, msg: string) => void;
  },
): () => void {
  const timer = setInterval(() => {
    void heartbeatRun(runId)
      .then((state) => {
        if (state === "alive") return;
        if (state === "aborted") {
          log.debug(
            { runId },
            "[runs] Abort requested from another replica; stopping",
          );
        } else if (state === "terminated") {
          log.warn(
            { runId },
            "[runs] Run was closed by another process; stopping without recording",
          );
        } else if (state === "lost") {
          log.warn({ runId }, "[runs] Lease lost; another replica took over");
        } else {
          log.warn({ runId }, "[runs] Run row disappeared; stopping");
        }
        onStop(state);
      })
      .catch((err: unknown) => {
        log.warn({ err, runId }, "[runs] Heartbeat failed");
      });
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

/**
 * Find runs whose owning process died and that are worth resuming.
 *
 * A run qualifies when it is still `running` with a stale claim, or when it was
 * `interrupted` and has a checkpoint to continue from.
 *
 * @param limit - Maximum rows to return.
 * @default limit 10
 * @param kind - Run kind to search.
 * @default kind "workflow"
 * @returns The adoptable run rows.
 */
export async function findResumableRuns(
  limit = 10,
  kind: KindOf = "workflow",
): Promise<Selectable<RunsTable>[]> {
  const staleBefore = staleCutoff();
  return await getDb()
    .selectFrom("runs")
    .selectAll()
    .where("kind", "=", kind)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("status", "=", "running"),
          eb.or([
            eb("claimed_at", "<", staleBefore),
            eb.and([
              eb("claimed_at", "is", null),
              eb("started_at", "<", staleBefore),
            ]),
          ]),
        ]),
        eb.and([
          eb("status", "=", "interrupted"),
          eb("checkpoint", "is not", null),
          eb("finished_at", "<", staleBefore),
        ]),
      ]),
    )
    .limit(limit)
    .execute();
}

/**
 * Close stale runs that have nothing to resume from.
 *
 * Runs with a checkpoint are left alone so the recovery sweep can continue them;
 * this only closes rows whose owner is gone and which would otherwise stay
 * `running` forever.
 *
 * @returns How many rows were closed.
 */
export async function markStaleRunsInterrupted(): Promise<number> {
  const staleBefore = staleCutoff();
  const updated = await getDb()
    .updateTable("runs")
    .set({
      status: "interrupted",
      finished_at: timestamp(),
      owner: null,
      claimed_at: null,
      error: "The process running this run stopped before it finished",
    })
    .where("status", "=", "running")
    .where("checkpoint", "is", null)
    .where((eb) =>
      eb.or([
        eb("claimed_at", "is", null),
        eb("claimed_at", "<", staleBefore),
      ]),
    )
    .returning("id")
    .execute();
  return updated.length;
}
