import { getDb } from "../config/config";
import type { RunKind, RunStatus } from "../db/schema";
import { timestamp, toJson } from "../db/utils";
import type { CreateRunArgs, StoredRun, UpdateRunArgs } from "../types/RunModel";

/**
 * Insert a new run row in the `running` state.
 *
 * Call this before doing any work, so a crash still leaves a resumable record.
 *
 * @param args - The run's identity, kind and initial input.
 */
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

/**
 * Patch a run row. Fields left `undefined` are not touched.
 *
 * @param args - The run id plus any of status, partial output, stop reason,
 * error, message id, or `finished: true` to stamp `finished_at` now.
 */
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

/**
 * Read one run by id.
 *
 * @param id - The run id.
 * @returns The row, or `null` if there is no such run.
 */
export async function getRunById(id: string): Promise<StoredRun | null> {
  const row = await getDb()
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", id)
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * List a conversation's runs, newest first.
 *
 * @param conversationId - The conversation to read.
 * @param limit - Maximum rows to return.
 * @default limit 20
 * @returns The run rows.
 */
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
 * The most recent run of a conversation that ended before finishing.
 *
 * Used to offer a resume after a crash or an abort, without knowing which
 * workflow the run belonged to.
 *
 * @param args - The conversation, and optionally its owner and run kind.
 * @returns The newest interrupted, failed or aborted run, or `null`.
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
 * List finished or stopped runs for a user, newest first.
 *
 * @param userId - Owner of the runs.
 * @param limit - Maximum rows to return.
 * @default limit 20
 * @param kind - Run kind to filter by.
 * @default kind "workflow"
 * @returns The run rows.
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


