import { Logger } from "../config/configSchema.js";
import {
  CacheHit,
  checkChatSemanticCache,
} from "../models/chatSemanticCache.js";
import { saveCachedExchange } from "../models/saveMessages.js";
import { staticReplyStream } from "./sse.js";

export async function tryCachedReply(
  skipOnTools: string[],
  args: {
    convId: number;
    message: string;
    embedding: number[];
    log: Logger;
    stream: boolean;
    similarity: number;
    cacheWindowHours: number;
  },
  skipEvaluator?: (convId: number, message: string) => boolean,
): Promise<ReadableStream<Uint8Array> | null | CacheHit> {
  let shouldSkip = false;

  if (skipEvaluator) {
    shouldSkip = skipEvaluator(args.convId, args.message);
  }

  if (shouldSkip) return null;

  const hit = await checkChatSemanticCache(
      args.embedding,
      args.similarity,
      args.cacheWindowHours,
      skipOnTools,
    );

  if (!hit.hit || !hit.content) return null;

  args.log.info(
    { convId: args.convId, matchedId: hit.matchedMessageId },
    "Semantic cache HIT",
  );
  await saveCachedExchange(
    args.convId,
    args.message,
    args.embedding,
    hit.content,
  );

  if (args.stream) {
    return staticReplyStream(args.convId, hit.content);
  }

  return hit;
}
