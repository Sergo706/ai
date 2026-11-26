import { getDb } from "../config/config";

/**
 * List a user's conversations, most recently updated first.
 *
 * @param userId - Owner of the conversations.
 * @param limit - Maximum rows to return.
 * @default limit 50
 * @param offset - Rows to skip, for paging.
 * @default offset 0
 * @returns `ok: true` with the page of conversations.
 */
export async function getConversations(userId: string, limit = 50, offset = 0) {
  const rows = await getDb()
    .selectFrom("conversations")
    .select([
      "id",
      "title",
      "created_at as createdAt",
      "updated_at as updatedAt",
    ])
    .where("user_id", "=", userId)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();

  return {
    ok: true,
    date: new Date().toISOString(),
    data: rows,
  };
}
