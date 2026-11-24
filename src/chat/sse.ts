import { SseEvent, SseFrame, WorkflowAgent, WorkflowName } from "../types/Chat";
import type { WorkflowProgressUpdate } from "../agentic-loop/types";


const encoder = new TextEncoder();

/** A comment line that keeps an idle SSE connection open. */
export const SSE_HEARTBEAT = ": heartbeat\n\n";

/**
 * Encode one event as a `text/event-stream` frame.
 *
 * @param payload - The event or frame to send; JSON-serialised into `data:`.
 * @param id - Optional event id, letting a client resume from it.
 * @returns The wire-ready frame.
 * @example
 * ```ts
 * frame({ type: "chunk", text: "hi" }); // 'data: {"type":"chunk",...}\n\n'
 * ```
 */
export function frame(payload: SseEvent | SseFrame, id?: string): string {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  return id === undefined ? data : `id: ${id}\n${data}`;
}

/**
 * UTF-8 encode a frame for a `ReadableStream` controller.
 *
 * @param text - Frame text, usually from {@link frame} or {@link SSE_HEARTBEAT}.
 */
export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * Build the response headers an SSE endpoint must send.
 *
 * @returns Headers for `Content-Type`, `Cache-Control`, `Connection`,
 * `X-Accel-Buffering` and `Transfer-Encoding`. Spread them into your response.
 * @example
 * ```ts
 * return new Response(workflowStream(args), { headers: setSseHeaders() });
 * ```
 */
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

/**
 * A stream that replays a reply already in hand.
 *
 * Emits `init`, one `chunk` carrying the whole text, then `done`.
 *
 * @param conversationId - Sent in the `init` frame.
 * @param text - The complete assistant reply.
 */
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

/** Arguments for {@link workflowStream}. */
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
  /**
   * Milliseconds between keep-alive comments, so proxies do not close the
   * connection while the task is quiet.
   *
   * @default 15000
   */
  heartbeatMs?: number;
}

/**
 * Run a long task as a Server-Sent Events body.
 *
 * Emits whatever `execute` sends, a heartbeat while it works, then `done`.
 * A throw from `execute` becomes one `error` frame instead of a broken stream.
 *
 * @param args - The task to run and how to report its failures.
 * @returns A `ReadableStream` to hand straight to a `Response`.
 * @example
 * ```ts
 * return new Response(
 *   workflowStream({
 *     execute: async (emit) => runResearch(emit),
 *     onError: (err) => log.error({ err }, "research failed"),
 *   }),
 *   { headers: setSseHeaders() },
 * );
 * ```
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
 * Build the progress callbacks a streaming workflow route emits through.
 *
 * Each returned callback writes one SSE frame. Once `onRunStarted` has been
 * called, its run id is attached to every later frame, so a client that
 * attached mid-run still learns which run it is watching.
 *
 * @param emit - Writes one frame to the stream.
 * @param meta - The query and workflow name to stamp on every frame.
 * @returns Three callbacks: run start, workflow progress, and agent progress.
 * @example
 * ```ts
 * const progress = runProgressFrames(emit, { query, workflow: "research" });
 * progress.onRunStarted(runId);
 * progress.onProgress({ addedEvidence: true, label: "crawling" });
 * ```
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
