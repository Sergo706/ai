import { encode, frame, SSE_HEARTBEAT } from "../chat/sse";
import { StoredEvent } from "../types/Chat";
import { firstIndexAfter } from "./eventStore";
import { FIRST_ID } from "./eventStore";
import type { StreamFromRunParams } from "./types";

export function streamFromRun(
  p: StreamFromRunParams,
): ReadableStream<Uint8Array> {
  const { run, since = FIRST_ID, conversationId, log } = p;
  let unsubscribe: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const isClosed = (): boolean => closed;

      const keepAlive = setInterval(() => {
        send(SSE_HEARTBEAT);
      }, p.heartbeatMs ?? 10_000);
      (keepAlive as { unref?: () => void }).unref?.();

      const onEvent = (event: StoredEvent, id: string): void => {
        if (closed) return;
        send(frame(event, id));
        if (event.type === "done" || event.type === "error") close();
      };

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        run.subscribers.delete(onEvent);
      };

      const send = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encode(text));
        } catch {
          // A dead reader is only reported here, so unwind through `cleanup`:
          // setting the flag alone would make its own guard skip the cleanup.
          cleanup();
        }
      };

      const close = (): void => {
        cleanup();
        try {
          controller.close();
        } catch {}
      };

      if (conversationId !== undefined) {
        send(frame({ type: "init", conversationId, runId: run.id }));
      }
      const startIndex = firstIndexAfter(run.eventIds, since);
      for (let i = startIndex; i < run.events.length; i++) {
        if (isClosed()) return;
        send(frame(run.events[i], run.eventIds[i]));
      }

      if (run.status !== "running") {
        log.debug(
          { runId: run.id, status: run.status },
          "[runs] Replayed a finished run",
        );
        const last = run.events.at(-1);
        if (last?.type !== "done" && last?.type !== "error") {
          send(frame({ type: "done" }));
        }
        close();
        return;
      }

      run.subscribers.add(onEvent);
      unsubscribe = cleanup;
    },
    cancel() {
      unsubscribe?.();
    },
  });
}
