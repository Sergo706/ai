import { getDb } from "../config/config";

export async function getConversations(
  userId: string,
  limit = 50,
  offset = 0,
) {
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
