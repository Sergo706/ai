import { hostname } from "node:os";
import { sql, type Selectable } from "kysely";
import { envInt } from "@riavzon/utils/server";
import { getConfiguration, getDb } from "../config/config";
import type { RunKind, RunsTable } from "../db/schema";
import { timestamp, toJson } from "../db/utils";

/** One of the values `runs.kind` accepts. */
export type KindOf = RunKind;

/**
 * How long a claim stays valid without a heartbeat.
 *
 * Read once at module load, so changing it means restarting the process. The
 * floor of five seconds exists because a shorter lease than that turns a normal
 * garbage-collection pause into a false death and a duplicate run.
 */
export const LEASE_TTL_MS = envInt(
  "RUNS_LEASE_TTL_MS",
  getConfiguration().runs.leaseTtlMs,
  { min: 5_000 },
);

/**
 * How often a live run refreshes `claimed_at`.
 *
 * Clamped to half the lease rather than trusted. Setting
 * `RUNS_HEARTBEAT_INTERVAL_MS` above the TTL would let the lease expire between
 * two beats, so every live run would look dead and the sweep would adopt work
 * that is still running — the exact duplicate-execution bug the lease exists to
 * prevent. Clamping keeps a misconfiguration slow instead of catastrophic.
 */
export const HEARTBEAT_INTERVAL_MS = Math.min(
  envInt(
    "RUNS_HEARTBEAT_INTERVAL_MS",
    getConfiguration().runs.heartbeatIntervalMs,
    { min: 1_000 },
  ),
  Math.floor(LEASE_TTL_MS / 2),
);

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
 * Takes ownership of a run, but only if nobody else holds a fresh claim.
 *
 * The `WHERE` clause is the whole point. Two replicas booting at the same time
 * both try this, and exactly one of them gets a row back. Without the guard,
 * "the other node will pick it up" quietly becomes "every node runs it".
 *
 * @returns `true` when the lease is now ours.
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
 * @returns the reopened row, or `null` when the status changed in between.
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
 * `aborted`    — the row is still ours but was set to `aborted`, so another
 *                replica accepted a deliberate stop. Unwind without writing.
 * `terminated` — the row is still ours but ended some other way (`failed`,
 *                `interrupted`, `finished`). This process is a zombie whose
 *                bookkeeping was already done elsewhere, so it must stop and
 *                must not overwrite the recorded outcome.
 * `lost`       — the claim moved to another process that is now running it.
 * `gone`       — the row was deleted.
 *
 * The distinction between `aborted` and `terminated` exists so log lines and
 * run outcomes stay truthful. Collapsing them would report a harness-reclaimed
 * run as a user cancellation.
 */
export type LeaseState = "alive" | "aborted" | "terminated" | "lost" | "gone";

/**
 * Refreshes an existing claim and reports whether the run is still ours to run.
 *
 * This is the cross-replica abort path. Another replica cannot reach this
 * process's `AbortController`, but it can write `status = 'aborted'` to Postgres,
 * and the owner notices on its next beat — at most one interval, so a stop
 * button pressed on any replica terminates the loop within
 * `HEARTBEAT_INTERVAL_MS`. A pub/sub channel would be faster and would also need
 * a fallback, so the poll is the simpler correct answer.
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
 * Marks a run aborted from any replica, including one that does not own it.
 *
 * Deliberately does **not** clear `owner` or `claimed_at`. The owning process
 * still holds the claim while it unwinds, and releasing it early would let the
 * recovery sweep consider the run adoptable. It cannot anyway, because
 * `findResumableRuns` only looks at `status = 'running'`, but leaving the lease
 * intact also keeps `saveCheckpoint` quiet during shutdown.
 *
 * @returns `true` when this call was the one that cancelled it.
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
 * Records a successful finish, but only over a row that is still `running`.
 *
 * The guard closes a race that only exists with several replicas: a stop request
 * can land in the seconds between the loop returning and this write. An
 * unconditional `UPDATE` would flip `aborted` back to `finished` and tell the
 * user the run succeeded when they just cancelled it.
 *
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
 * Drops the claim so another replica may adopt the run immediately. Called on
 * both the success and failure paths: a finished run has nothing left to take
 * over, and a failed one should not be invisible for a full lease period.
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
 * Starts a heartbeat for a run and returns the stop function. The interval is
 * unref'd so it can never keep the process alive on its own.
 *
 * `onStop` fires on `aborted`, `terminated`, `lost` and `gone`: from the owner's
 * point of view they are all the same instruction, which is to stop spending
 * and unwind. Only the log line differs, because only `aborted` was the user's
 * decision and the operator reading the log needs that distinction.
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
 * Runs that belong to a dead process and are worth resuming.
 *
 * A row qualifies when it is still `running` and its claim is stale — the
 * literal definition of "this process died mid-run". A row that was created but
 * never claimed counts too once the create/claim gap is older than the lease,
 * because that gap is milliseconds wide: missing it means the writer died
 * between `createRun` and `claimRun`.
 *
 * `interrupted` is admitted only when the row carries a checkpoint. There are
 * two ways a row becomes `interrupted`: boot reconciliation, which closes rows
 * that have no snapshot and so have nothing to continue, and a transient
 * failure inside `runResearch` (a socket drop, a `429`, an upstream `503`),
 * which is nobody's decision to stop and is exactly the case worth resuming.
 * Requiring the checkpoint separates the two without needing a third status.
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
 * Closes runs whose owner is gone and which have nothing to resume from.
 *
 * Scoped to rows this instance can see as stale, so booting a second replica can
 * never touch the first one's live work — the bug the owner column exists to
 * prevent.
 *
 * The `checkpoint IS NULL` guard is what makes single-replica recovery work at
 * all. A stale row *with* a checkpoint is left `running` on purpose so the
 * recovery sweep can adopt it and continue from the last round. Marking it
 * `interrupted` here would be a one-way door, because the sweep only adopts
 * rows that are still `running`.
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
