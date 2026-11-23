import { getDb } from "../config/config";
import type { RunKind, RunStatus } from "../db/schema";
import { timestamp, toJson } from "../db/utils";
import type { CreateRunArgs, StoredRun, UpdateRunArgs } from "../types/RunModel";

export async function createRun(args: CreateRunArgs): Promise<void> {
  await getDb()
    .insertInto("runs")
    .values({
      id: args.id,
      kind: args.kind,
      query: args.query,
      user_id: args.userId ?? null,
      conversation_id: args.conversationId ?? null,
      input: toJson(args.input),
      status: "running",
    })
    .execute();
}

export async function updateRun(args: UpdateRunArgs): Promise<void> {
  const patch: {
    status?: RunStatus;
    partial?: string | null;
    stop_reason?: string | null;
    error?: string | null;
    message_id?: number | null;
    finished_at?: string;
  } = {};

  if (args.status !== undefined) patch.status = args.status;
  if (args.partial !== undefined) patch.partial = toJson(args.partial);
  if (args.stopReason !== undefined) patch.stop_reason = args.stopReason;
  if (args.error !== undefined) patch.error = args.error;
  if (args.messageId !== undefined) patch.message_id = args.messageId;
  if (args.finished === true) patch.finished_at = timestamp();

  if (Object.keys(patch).length === 0) return;
  await getDb()
    .updateTable("runs")
    .set(patch)
    .where("id", "=", args.id)
    .execute();
}

export async function getRunById(id: string): Promise<StoredRun | null> {
  const row = await getDb()
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", id)
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

export async function getRunsByConversation(
  conversationId: number,
  limit = 20,
): Promise<StoredRun[]> {
  return await getDb()
    .selectFrom("runs")
    .selectAll()
    .where("conversation_id", "=", conversationId)
    .orderBy("started_at", "desc")
    .limit(limit)
    .execute();
}

/**
 * The most recent workflow run of a conversation that ended without finishing.
 *
 * A run is resumable by kind and status alone, so this answers "what did the
 * user just see stop" without knowing which workflow it was. The `input.name`
 * discriminator says which resumer to hand it to.
 *
 * Ordered by `started_at` descending rather than `updated_at`, so the answer is
 * the run the user just saw stop rather than whichever row the recovery sweep
 * happened to touch last.
 */
export async function getLatestResumableRun(args: {
  conversationId: number;
  userId?: string | null;
  kind?: RunKind;
}): Promise<StoredRun | null> {
  const kind = args.kind ?? "workflow";

  let query = getDb()
    .selectFrom("runs")
    .selectAll()
    .where("kind", "=", kind)
    .where("conversation_id", "=", args.conversationId)
    .where("status", "in", ["interrupted", "failed", "aborted"]);

  if (args.userId !== undefined && args.userId !== null) {
    query = query.where("user_id", "=", args.userId);
  }

  const row = await query
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Runs that never produced a host-side record of their output.
 *
 * A workflow run that stops without a sufficient answer has no row in whatever
 * table the host persists its results to, so this table is the only place its
 * partial synthesis survives.
 */
export async function getUnpersistedRuns(
  userId: string,
  limit = 20,
  kind: RunKind = "workflow",
): Promise<StoredRun[]> {
  return await getDb()
    .selectFrom("runs")
    .selectAll()
    .where("kind", "=", kind)
    .where("user_id", "=", userId)
    .where("status", "in", ["aborted", "failed", "interrupted", "finished"])
    .orderBy("started_at", "desc")
    .limit(limit)
    .execute();
}


