import { getConfiguration, getDb } from "../config/config";
import type { MessageTrace } from "../db/schema";
import { toJson, toVec } from "../db/utils";

/**
 * Store a user message, with its embedding for later retrieval.
 *
 * @param conversationId - Conversation the message belongs to.
 * @param content - The message text.
 * @param embedding - Vector from `generateMatchingEmbedding`.
 */
export async function saveUserMessage(
  conversationId: number,
  content: string,
  embedding: number[],
): Promise<void> {
  await getDb()
    .insertInto("messages")
    .values({
      conversation_id: conversationId,
      role: "user",
      content,
      embedding: toVec(embedding),
    })
    .execute();
}

/**
 * Store a user question and its cached answer as one pair.
 *
 * Used when serving a semantic-cache hit, so the exchange still appears in the
 * conversation history.
 *
 * @param conversationId - Conversation the exchange belongs to.
 * @param userContent - The question text.
 * @param embedding - Embedding of the question.
 * @param assistantContent - The cached answer.
 */
export async function saveCachedExchange(
  conversationId: number,
  userContent: string,
  embedding: number[],
  assistantContent: string,
): Promise<void> {
  await getDb()
    .insertInto("messages")
    .values([
      {
        conversation_id: conversationId,
        role: "user",
        content: userContent,
        embedding: toVec(embedding),
      },
      {
        conversation_id: conversationId,
        role: "assistant",
        content: assistantContent,
      },
    ])
    .execute();
}

/**
 * Store an assistant reply with its trace.
 *
 * @param args - The conversation, answer text, tool names used, and the
 * collected trace (or `null`).
 * @returns The inserted message id, or `null` when the text was empty.
 */
export async function saveAssistantMessage(args: {
  conversationId: number;
  content: string;
  toolsUsed: string[];
  trace: MessageTrace | null;
}): Promise<{ id: number } | null> {
  const log = getConfiguration().logger;

  try {
    const row = await getDb()
      .insertInto("messages")
      .values({
        conversation_id: args.conversationId,
        role: "assistant",
        content: args.content,
        tools_used: toJson(args.toolsUsed),
        trace: toJson(args.trace),
      })
      .returning("id")
      .executeTakeFirst();

    return row ?? null;
  } catch (err) {
    log.error({ err }, "Failed to save final assistant message");
    return null;
  }
}
