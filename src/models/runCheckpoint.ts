import { getConfiguration, getDb } from "../config/config";
import { fromJson, toJson } from "../db/utils";
import type { Checkpoint } from "../types/Checkpoint";
import { INSTANCE_ID } from "./runLease";

/**
 * Save a checkpoint for a run this process still owns.
 *
 * Writes are silently skipped when another replica has taken the run, and
 * failures are logged rather than thrown: a lost checkpoint only costs
 * re-running the last round.
 *
 * @param args - The run id and the snapshot to store.
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
 * Read the checkpoint a previous process left for a run.
 *
 * @param runId - The run to resume.
 * @returns The snapshot, or `null` when the run has none yet.
 */
export async function loadCheckpoint(
  runId: string,
): Promise<Checkpoint | null> {
  const row = await getDb()
    .selectFrom("runs")
    .select("checkpoint")
    .where("id", "=", runId)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return fromJson<Checkpoint>(row.checkpoint);
}
