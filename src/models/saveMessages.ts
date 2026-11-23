import { getConfiguration, getDb } from "../config/config";
import type { MessageTrace } from "../db/schema";
import { toJson, toVec } from "../db/utils";

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
