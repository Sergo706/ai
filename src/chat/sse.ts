import { SseEvent, SseFrame, WorkflowAgent, WorkflowName } from "../types/Chat";
import type { WorkflowProgressUpdate } from "../agentic-loop/types";


const encoder = new TextEncoder();

export const SSE_HEARTBEAT = ": heartbeat\n\n";


export function frame(payload: SseEvent | SseFrame, id?: string): string {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  return id === undefined ? data : `id: ${id}\n${data}`;
}

export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function setSseHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Transfer-Encoding": "chunked"
  }
  return headers;
}

export function staticReplyStream(
  conversationId: number,
  text: string,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encode(frame({ type: "init", conversationId })));
      controller.enqueue(encode(frame({ type: "chunk", text })));
      controller.enqueue(encode(frame({ type: "done" })));
      controller.close();
    },
  });
}

export interface WorkflowStreamArgs {
  /**
   * Runs the work, reporting progress with `emit`, and resolves with the
   * terminal payload of the run (the same object the JSON branch returns).
   *
   * Throwing is how a failure is reported: this helper turns it into one
   * `error` frame. The caller is responsible for logging, because only it knows
   * which workflow threw.
   */
  execute: (emit: (payload: SseFrame) => void) => Promise<SseFrame>;
  /** Called once when `execute` throws, before the `error` frame is written. */
  onError?: (err: unknown) => void;
  heartbeatMs?: number;
}

/**
 * Turns a long workflow into a Server-Sent Events body.
 *
 * The four research-family routes emit the same shape of stream, so the
 * mechanics — encoder, heartbeat, close-once bookkeeping, terminal frame — live
 * here instead of being reimplemented per route. What stays in the route is the
 * part that is actually route-specific: which workflow runs and what its
 * progress means.
 *
 * Deliberately knows nothing about the run registry. Registering a handle is
 * what makes a run reattachable, and that lives in
 * `server/lib/runs/detachedWorkflowStream.ts` so this module stays a pure
 * encoder and cannot grow a dependency on the database layer.
 */
export function workflowStream(
  args: WorkflowStreamArgs,
): ReadableStream<Uint8Array> {
  const heartbeatMs = args.heartbeatMs ?? 15_000;

  return new ReadableStream({
    async start(controller) {
      let closed = false;

      const send = (payload: SseFrame): void => {
        if (closed) return;
        try {
          controller.enqueue(encode(frame(payload)));
        } catch {
          closed = true;
        }
      };

      const keepAlive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encode(SSE_HEARTBEAT));
        } catch {
          closed = true;
        }
      }, heartbeatMs);

      try {
        const result = await args.execute(send);
        send(result);
        send({ type: "done" });
      } catch (err) {
        args.onError?.(err);
        send({ type: "error", message: "Server error please try again" });
      } finally {
        clearInterval(keepAlive);
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      }
    },
  });
}

/**
 * The progress pair every research-family route passes to its runner.
 *
 * `research_start` announces the run id, and the id is repeated on every page
 * frame so a client that attached mid-run still learns it. Both are needed for
 * the stop button and for `POST /api/runs/{id}/retry` to have anything to work
 * with.
 *
 * `workflow` is the route's own identity, sent explicitly rather than inferred
 * from `researchType`: the team reuses `"combined"` as its retrieval flavour and
 * deep research reuses the user's `"general"`, so the flavour cannot tell the
 * four routes apart. Without it every live crawl renders as deep research.
 */
export function runProgressFrames(
  emit: (payload: SseFrame) => void,
  meta: { query: string; workflow: WorkflowName },
): {
  onRunStarted: (runId: string) => void;
  onProgress: (progress: WorkflowProgressUpdate) => void;
  onAgentProgress: (progress: {
    agent: WorkflowAgent;
    state: "running" | "done" | "failed";
  }) => void;
} {
  const started = { runId: undefined as string | undefined };

  const withRunId = (payload: SseFrame): SseFrame =>
    started.runId === undefined
      ? payload
      : { ...payload, runId: started.runId };

  return {
    onRunStarted: (runId: string) => {
      started.runId = runId;
      emit({
        type: "workflow_start",
        query: meta.query,
        workflow: meta.workflow,
        runId,
      });
    },
    onProgress: (progress) => {
      emit(withRunId({ type: "workflow_progress", workflow: meta.workflow, ...progress }));
    },

    onAgentProgress: ({ agent, state }) => {
      emit(withRunId({ type: "agent_progress", agent, state }));
    },
  };
}
