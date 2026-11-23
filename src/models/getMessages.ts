import { getDb } from "../config/config";

export async function getMessages(userId: string, conversationId: number) {
  const db = getDb();

  const conversation = await db
    .selectFrom("conversations")
    .select("id")
    .where("id", "=", conversationId)
    .where("user_id", "=", userId)
    .limit(1)
    .executeTakeFirst();

  if (!conversation) {
    return {
      ok: false,
      date: new Date().toISOString(),
      reason: "Conversation not found",
    } as const;
  }

  const rows = await db
    .selectFrom("messages")
    .select([
      "id",
      "role",
      "content",
      "created_at as createdAt",
      "tools_used as toolsUsed",
      "trace",
    ])
    .where("conversation_id", "=", conversationId)
    .orderBy("created_at", "asc")
    .execute();

  return {
    ok: true,
    date: new Date().toISOString(),
    data: rows,
  } as const;
}
