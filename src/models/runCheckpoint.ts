import { getConfiguration, getDb } from "../config/config";
import { fromJson, toJson } from "../db/utils";
import type { Checkpoint } from "../types/Checkpoint";
import { INSTANCE_ID } from "./runLease";

/**
 * Writes a checkpoint, but only while this process still owns the run.
 *
 * The `AND owner = $self` is not decoration. Once another replica has claimed
 * the run, this process is a zombie: it will keep finishing its current round
 * and would otherwise overwrite the snapshot of whoever took over with a stale
 * one, sending the successor back in time. The guard has to be in the `WHERE`
 * clause, not a post-write comparison — a post-write check still performs the
 * write.
 *
 * Failures are logged and swallowed. A snapshot is an optimisation; losing one
 * costs a re-run of the last round, while throwing here would kill a run that is
 * otherwise healthy.
 */
export async function saveCheckpoint(args: {
  runId: string;
  /** The envelope the workflow built. `state` inside it stays opaque. */
  snapshot: Checkpoint;
}): Promise<void> {
  const { runId, snapshot } = args;
  const log = getConfiguration().logger;
  try {
    const updated = await getDb()
      .updateTable("runs")
      .set({ checkpoint: toJson(snapshot) })
      .where("id", "=", runId)
      .where("owner", "=", INSTANCE_ID)
      .returning("id")
      .executeTakeFirst();

    if (!updated) {
      const row = await getDb()
        .selectFrom("runs")
        .select("owner")
        .where("id", "=", runId)
        .limit(1)
        .executeTakeFirst();
      if (!row) {
        log.warn({ runId }, "[runs] Checkpoint discarded: the run is gone");
        return;
      }
      log.warn(
        { runId, owner: row.owner },
        "[runs] Checkpoint discarded: the lease is no longer ours",
      );
    }
  } catch (err) {
    log.warn({ err, runId }, "[runs] Could not write checkpoint");
  }
}

/**
 * Reads a checkpoint written by a previous process. Returns `null` for a row
 * with no snapshot, which is the normal case for a run that never reached its
 * first round boundary.
 */
export async function loadCheckpoint(runId: string): Promise<Checkpoint | null> {
  const row = await getDb()
    .selectFrom("runs")
    .select("checkpoint")
    .where("id", "=", runId)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return fromJson<Checkpoint>(row.checkpoint);
}
