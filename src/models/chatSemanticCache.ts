import { sql } from "kysely";
import { getDb } from "../config/config";
import { getDistance, fromJson, isPg } from "../db/utils";


/** A semantic-cache lookup result. */
export interface CacheHit {
  /** Whether a similar-enough earlier question was found. */
  hit: boolean;
  /** The stored answer, when `hit` is true. */
  content?: string;
  /** Id of the matched user message, when `hit` is true. */
  matchedMessageId?: number;
}

/**
 * Look for an earlier question close enough to answer this one.
 *
 * @param queryEmbedding - Embedding of the current question.
 * @param similarityThreshold - Minimum cosine similarity, e.g. `0.9`.
 * @param CHAT_CACHE_WINDOW_HOURS - How far back to search.
 * @default CHAT_CACHE_WINDOW_HOURS 24
 * @param poisonTools - Tools whose earlier use disqualifies a cached answer.
 * @returns The match, or `{ hit: false }`.
 */
export async function checkChatSemanticCache(
  queryEmbedding: number[],
  similarityThreshold: number,
  CHAT_CACHE_WINDOW_HOURS = 24,
  poisonTools: string[] = [],
  userId?: string,
): Promise<CacheHit> {
  const db = getDb();
  const distance = getDistance(queryEmbedding);
  const similarityScore = sql<number>`1 - (${distance})`;

  const withinWindow = isPg()
    ? sql<boolean>`m.created_at >= CURRENT_TIMESTAMP - (${sql.lit(CHAT_CACHE_WINDOW_HOURS)} * INTERVAL '1 hour')`
    : sql<boolean>`m.created_at >= datetime('now', '-' || ${sql.lit(CHAT_CACHE_WINDOW_HOURS)} || ' hours')`;

  const baseQuery = db
    .selectFrom("messages as m")
    .select(["m.id", "m.conversation_id as conversationId"])
    .select(similarityScore.as("similarity"))
    .where("m.role", "=", "user")
    .where("m.embedding", "is not", null)
    .where(withinWindow);

  const matchedUserMsg = await (
    userId !== undefined
      ? baseQuery
          .innerJoin("conversations as c", "c.id", "m.conversation_id")
          .where("c.user_id", "=", userId)
      : baseQuery
  )
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
