import { getDb } from "../config/config";
import type { CompactionUpdate } from "../types/Compaction";

/**
 * Record how far a conversation has been summarised.
 *
 * @param conversationId - Conversation being compacted.
 * @param update - The summary and the message id it covers.
 * @returns `true` when written or nothing needed writing; `false` when the
 * conversation does not exist.
 */
export async function saveConversationCompaction(
  conversationId: number,
  update: CompactionUpdate,
): Promise<boolean> {
  if (!update.changed) return true;

  const result = await getDb()
    .updateTable("conversations")
    .set({
      compacted_summary: update.summary,
      compacted_through_message_id: update.throughMessageId,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", conversationId)
    .executeTakeFirst();

  return Number(result.numUpdatedRows) > 0;
}
