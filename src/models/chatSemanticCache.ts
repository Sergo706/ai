import { sql } from "kysely";
import { getDb } from "../config/config";
import { getDistance, fromJson, isPg } from "../db/utils";


export interface CacheHit {
  hit: boolean;
  content?: string;
  matchedMessageId?: number;
}

export async function checkChatSemanticCache(
  queryEmbedding: number[],
  similarityThreshold: number,
  CHAT_CACHE_WINDOW_HOURS = 24,
  poisonTools: string[]
): Promise<CacheHit> {
  const db = getDb();
  const distance = getDistance(queryEmbedding);
  const similarityScore = sql<number>`1 - (${distance})`;

  const withinWindow = isPg()
    ? sql<boolean>`created_at >= CURRENT_TIMESTAMP - (${sql.lit(CHAT_CACHE_WINDOW_HOURS)} * INTERVAL '1 hour')`
    : sql<boolean>`created_at >= datetime('now', '-' || ${sql.lit(CHAT_CACHE_WINDOW_HOURS)} || ' hours')`;

  const matchedUserMsg = await db
    .selectFrom("messages")
    .select(["id", "conversation_id as conversationId"])
    .select(similarityScore.as("similarity"))
    .where("role", "=", "user")
    .where("embedding", "is not", null)
    .where(withinWindow)
    .orderBy(distance, "asc")
    .limit(1)
    .executeTakeFirst();

  if (!matchedUserMsg || matchedUserMsg.similarity < similarityThreshold) {
    return { hit: false };
  }

  const assistantReply = await db
    .selectFrom("messages")
    .select(["content", "tools_used"])
    .where("conversation_id", "=", matchedUserMsg.conversationId)
    .where("role", "=", "assistant")
    .where("id", ">", matchedUserMsg.id)
    .orderBy("id", "asc")
    .limit(1)
    .executeTakeFirst();

  if (!assistantReply?.content) {
    return { hit: false };
  }


  const hasPoisonTool = (fromJson<string[]>(assistantReply.tools_used) ?? []).some(
    (tool) => poisonTools.includes(tool),
  );

  if (hasPoisonTool) {
    return { hit: false };
  }

  return {
    hit: true,
    content: assistantReply.content,
    matchedMessageId: matchedUserMsg.id,
  };
}
