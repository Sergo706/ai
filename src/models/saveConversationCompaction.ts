import { getDb } from "../config/config";
import type { CompactionUpdate } from "../types/Compaction";

/**
 * Persists the conversation's compaction state.
 *
 * @returns `true` when the row was updated, or when there was nothing to write.
 * `false` means the conversation id does not exist.
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
