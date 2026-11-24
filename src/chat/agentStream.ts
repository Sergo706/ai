import type { EventSink } from "./eventSink.js";
import type { TraceCollector } from "./traceCollector.js";
import type { RequestAbort } from "./requestAbort.js";
import { AgentEvent } from "../types/ToolExecutionTypes.js";
import { getConfiguration } from "../config/config.js";
import { encode, frame, SSE_HEARTBEAT } from "./sse.js";
import { RequestAbortedError } from "../tools/execution/errors.js";

/** Everything {@link runAgentStream} needs for one streaming turn. */
export interface AgentStreamParams {
  agent: AsyncIterable<AgentEvent>;
  convId: number;
  sink: EventSink;
  trace: TraceCollector;
  abort: RequestAbort;
  onFinish: () => Promise<void>;
  /**
   * Milliseconds between keep-alive comments.
   *
   * @default 10000
   */
  heartbeatMs?: number;
}

/**
 * Stream an agent turn as a Server-Sent Events body.
 *
 * Forwards every agent event, emits a heartbeat while the turn runs, mirrors
 * progress into the trace and sink, and ends with a terminal frame.
 *
 * @param p - The agent's event stream and the turn's collaborators.
 * @returns A `ReadableStream` to hand straight to a `Response`.
 */
export function runAgentStream(
  p: AgentStreamParams,
): ReadableStream<Uint8Array> {
  const log = getConfiguration().logger;
  const { agent, convId, sink, trace, abort, onFinish } = p;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encode(text));
        } catch {
          closed = true;
        }
      };

      const sendEvent = (event: AgentEvent): void => {
        trace.apply(event);
        send(frame(event));
      };

      sink.attach(sendEvent);
      const keepAlive = setInterval(() => {
        send(SSE_HEARTBEAT);
      }, p.heartbeatMs ?? 10_000);

      try {
        send(frame({ type: "init", conversationId: convId }));
        try {
          for await (const event of agent) sendEvent(event);
          send(frame({ type: "done" }));
        } catch (err) {
          const aborted =
            err instanceof RequestAbortedError || abort.signal.aborted;
          if (!aborted) {
            log.error({ err }, "Agent failure during stream");
            sendEvent({
              type: "error",
              message:
                "The agent encountered an error and could not complete the response.",
            });
          }
        }
      } finally {
        clearInterval(keepAlive);
        sink.detach();
        closed = true;
        abort.markFinished();
        try {
          controller.close();
        } catch (err) {
          log.debug({ err }, "controller.close failed (already closed)");
        }
        try {
          await onFinish();
        } catch (err) {
          log.error({ err }, "Failed to persist the finished exchange");
        }
      }
    },
    cancel() {
      closed = true;
      abort.markFinished();
      abort.abort();
    },
  });
}
