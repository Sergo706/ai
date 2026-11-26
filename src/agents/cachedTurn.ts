import { tryCachedReply } from "../chat/semanticCacheReply";
import type { Logger } from "../config/configSchema";
import { createRun, updateRun } from "../models/runs";
import { generateMatchingEmbedding } from "../rag";
import { publish, scheduleDisposal } from "../runs/runRegistry";
import type { RunHandle } from "../runs/types";
import type { SseFrame } from "../types/Chat";
import { framesOf } from "./frames";
import type { ChatStream, ChatTurnResult, SemanticCacheOptions } from "./types";

/**
 * Answers from a near-identical earlier exchange, when it is safe to.
 *
 * Returns `null` whenever the cache cannot be trusted for this turn: no
 * conversation to search, or attached files (their content is inlined into the
 * stored message and would poison a later text-only ask).
 *
 * When a managed `run` is active, a cache hit still creates and finishes its
 * run row, publishes the cached reply and `done` to the `RunHandle`, and
 * schedules disposal so clients can replay or inspect the `runId`.
 */
export async function cachedTurn<TStructured>(args: {
  options: SemanticCacheOptions | undefined;
  conversationId: number | undefined;
  userId?: string;
  hasFiles: boolean;
  message: string;
  embedding?: number[];
  log: Logger;
  run?: RunHandle;
  runName?: string;
}): Promise<ChatStream<TStructured> | null> {
  const {
    options,
    conversationId,
    userId,
    hasFiles,
    message,
    log,
    run,
    runName,
  } = args;
  if (options === undefined || conversationId === undefined) return null;
  if (hasFiles) return null;

  const embedding =
    args.embedding ?? (await generateMatchingEmbedding(message));

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
      userId,
    },
    options.skipEvaluator,
  );

  if (cached === null || !("hit" in cached) || !cached.hit) return null;

  const text = cached.content ?? "";

  if (run !== undefined) {
    await createRun({
      id: run.id,
      kind: run.kind,
      query: message,
      userId: userId ?? null,
      conversationId,
      ...(runName === undefined ? {} : { input: { name: runName } }),
    });
    await updateRun({
      id: run.id,
      status: "finished",
      partial: { text },
      finished: true,
    });
    if (text !== "") publish(run, { type: "chunk", text });
    publish(run, { type: "done" });
    run.status = "finished";
    scheduleDisposal(run);
  }

  const frames: SseFrame[] = [
    { type: "init", conversationId },
    { type: "chunk", text },
    { type: "done" },
  ];

  return {
    frames: framesOf(frames),
    done: Promise.resolve({
      runId: run?.id,
      conversationId,
      text,
      toolsUsed: [],
      trace: null,
      cached: true,
    } satisfies ChatTurnResult<TStructured>),
  };
}
