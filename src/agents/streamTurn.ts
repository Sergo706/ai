import { RequestAbortedError, executeToolLoop } from "../tools/execution";
import type { ToolLoopOptions } from "../types/ToolExecutionTypes";
import type { SseFrame } from "../types/Chat";
import type { TraceCollector } from "../chat/traceCollector";
import type { TerminalStatus } from "../runs/types";
import { FrameQueue } from "./frames";
import type { ChatStream, ChatTurnResult } from "./types";

/**
 * The streaming turn, for a caller that consumes frames.
 *
 * With no run, the loop starts when the first frame is pulled: nothing asks for
 * an answer until someone reads it, and `complete()` drains to make that
 * happen. With a run, it starts immediately and finishes on its own, because the
 * row is the point — a reader may leave and reattach while the work continues.
 */
export function runStreamTurn<TStructured>(args: {
  loopOptions: ToolLoopOptions;
  trace: TraceCollector<Record<string, unknown>>;
  finish: (
    status: TerminalStatus,
    extra: { error?: string },
  ) => Promise<ChatTurnResult<TStructured>>;
  conversationId: number | undefined;
  stopHeartbeat: (() => void) | undefined;
  eager: boolean;
}): ChatStream<TStructured> {
  const { loopOptions, trace, finish, conversationId, stopHeartbeat, eager } =
    args;
  const queue = new FrameQueue();

  let resolveDone: (result: ChatTurnResult<TStructured>) => void = () => {
    // Replaced below before any frame is pulled.
  };
  const done = new Promise<ChatTurnResult<TStructured>>((resolve) => {
    resolveDone = resolve;
  });

  const start = (): void => {
    queue.push({ type: "init", conversationId });

    void (async () => {
      let status: TerminalStatus = "finished";
      let error: string | undefined;

      try {
        for await (const event of executeToolLoop({
          ...loopOptions,
          stream: true,
        })) {
          trace.apply(event);
          queue.push(event);
        }
      } catch (err) {
        if (err instanceof RequestAbortedError || loopOptions.signal?.aborted) {
          status = "aborted";
        } else {
          status = "failed";
          error = err instanceof Error ? err.message : String(err);
          queue.push({
            type: "error",
            message: "The agent encountered an error and could not complete.",
          });
        }
      } finally {
        queue.push({ type: "done" });
        queue.close();
        stopHeartbeat?.();
        resolveDone(await finish(status, error === undefined ? {} : { error }));
      }
    })();
  };

  let started = eager;
  if (eager) start();

  const frames: AsyncIterable<SseFrame> = {
    [Symbol.asyncIterator]: () => {
      if (!started) {
        started = true;
        start();
      }
      return queue.frames()[Symbol.asyncIterator]();
    },
  };

  return { frames, done };
}
