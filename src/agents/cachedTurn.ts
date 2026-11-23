import { tryCachedReply } from "../chat/semanticCacheReply";
import { generateMatchingEmbedding } from "../rag/embedding";
import type { Logger } from "../config/configSchema";
import type { SseFrame } from "../types/Chat";
import { framesOf } from "./frames";
import type { ChatStream, ChatTurnResult, SemanticCacheOptions } from "./types";

/**
 * Answers from a near-identical earlier exchange, when it is safe to.
 *
 * Returns `null` whenever the cache cannot be trusted for this turn: no
 * conversation to search, attached files (their content is inlined into the
 * stored message and would poison a later text-only ask), or runs being on,
 * because a managed run must exist for the client to reattach to.
 */
export async function cachedTurn<TStructured>(args: {
  options: SemanticCacheOptions | undefined;
  conversationId: number | undefined;
  hasFiles: boolean;
  message: string;
  log: Logger;
  managed: boolean;
}): Promise<ChatStream<TStructured> | null> {
  const { options, conversationId, hasFiles, message, log, managed } = args;
  if (options === undefined || conversationId === undefined) return null;
  if (hasFiles || managed) return null;

  const embedding = await generateMatchingEmbedding(message);
  const cached = await tryCachedReply(
    [...(options.poisonTools ?? [])],
    {
      convId: conversationId,
      message,
      embedding,
      log,
      stream: false,
      similarity: options.similarity ?? 0.9,
      cacheWindowHours: options.windowHours ?? 24,
    },
    options.skipEvaluator,
  );

  if (cached === null || !("hit" in cached) || !cached.hit) return null;

  const text = cached.content ?? "";
  const frames: SseFrame[] = [
    { type: "init", conversationId },
    { type: "chunk", text },
    { type: "done" },
  ];

  return {
    frames: framesOf(frames),
    done: Promise.resolve({
      runId: undefined,
      conversationId,
      text,
      toolsUsed: [],
      trace: null,
      cached: true,
    } satisfies ChatTurnResult<TStructured>),
  };
}
