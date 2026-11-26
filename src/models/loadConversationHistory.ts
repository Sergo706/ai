import { getDb } from "../config/config";
import type { MessageTrace } from "../db/schema";
import { fromJson } from "../db/utils";
import type { CompactionState } from "../types/Compaction";

/**
 * Load a conversation's stored turns and compaction state.
 *
 * @param userId - Owner, checked against the conversation.
 * @param conversationId - Existing conversation, or `undefined` for a new one.
 * @param currentMessage - Used to title a newly created conversation.
 * @returns The history and compaction state, or `ok: false` with a reason.
 */
export async function loadConversationHistory(
  userId: string,
  conversationId: number | undefined,
  currentMessage: string,
) {
  const db = getDb();

  if (conversationId) {
    const existingConv = await db
      .selectFrom("conversations")
      .select(["id", "compacted_summary", "compacted_through_message_id"])
      .where("id", "=", conversationId)
      .where("user_id", "=", userId)
      .limit(1)
      .executeTakeFirst();

    if (!existingConv) {
      return {
        ok: false,
        date: new Date().toISOString(),
        reason: "Conversation not found",
      };
    }

    const dbMessages = await db
      .selectFrom("messages")
      .select(["id", "role", "content", "trace"])
      .where("conversation_id", "=", existingConv.id)
      .orderBy("id", "asc")
      .execute();

    const res = dbMessages
      .filter((msg) => msg.role === "user" || msg.role === "assistant")
      .map((msg) => ({
        id: msg.id,
        role: msg.role as "user" | "assistant",
        message: msg.content,
        trace: fromJson<MessageTrace>(msg.trace),
      }));

    const compaction: CompactionState = {
      summary: existingConv.compacted_summary ?? null,
      throughMessageId: existingConv.compacted_through_message_id ?? null,
    };

    return {
      ok: true,
      date: new Date().toISOString(),
      data: {
        existedId: existingConv.id,
        conversation: res,
        compaction,
      },
    };
  } else {
    const newConv = await db
      .insertInto("conversations")
      .values({
        user_id: userId,
        title: currentMessage.substring(0, 50).trim() + "...",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return {
      ok: true,
      date: new Date().toISOString(),
      data: {
        newConversationId: newConv.id,
      },
    };
  }
}
