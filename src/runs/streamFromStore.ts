import { encode, frame, SSE_HEARTBEAT } from "../chat/sse";
import { StoredEvent } from "../types/Chat";
import { FIRST_ID, tailRun } from "./eventStore";
import type { StreamFromStoreParams } from "./types";

/**
 * Stream a run from the shared event store, from any replica.
 *
 * This is the cross-replica counterpart to `streamFromRun`: the cursor is a
 * stream id, so a client that reconnects gets exactly the events after the last
 * one it saw, even if another replica answers.
 *
 * @param p - The run, the resume cursor, and a liveness check used when the
 * stream goes quiet.
 * @returns A `ReadableStream` to hand straight to a `Response`.
 * @example
 * ```ts
 * return new Response(
 *   streamFromStore({ runId, since, log, isRunAlive }),
 *   { headers: setSseHeaders() },
 * );
 * ```
 */
export function streamFromStore(
  p: StreamFromStoreParams,
): ReadableStream<Uint8Array> {
  let stop: (() => void) | undefined;
  /**
   * `cancel()` runs outside `start`, so it cannot reach the closures built
   * there. This is the one handle it needs: everything teardown must do.
   */
  let teardown: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const isClosed = (): boolean => closed;

      const keepAlive = setInterval(() => {
        send(SSE_HEARTBEAT);
      }, p.heartbeatMs ?? 10_000);
      (keepAlive as { unref?: () => void }).unref?.();

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        stop?.();
      };

      const close = (): void => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      };

      const send = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encode(text));
        } catch {
          // A dead reader is only reported here, so unwind through `close`:
          // setting the flag alone would make its own guard skip the cleanup.
          close();
        }
      };

      teardown = cleanup;

      if (p.conversationId !== undefined) {
        send(
          frame({
            type: "init",
            conversationId: p.conversationId,
            runId: p.runId,
          }),
        );
      }

      stop = tailRun({
        runId: p.runId,
        afterId: p.since ?? FIRST_ID,
        log: p.log,
        shouldStop: () => closed,
        onEvent: (event: StoredEvent, id: string) => {
          send(frame(event, id));
          if (event.type === "done" || event.type === "error") close();
        },
        onIdle: async () => {
          const alive = await p.isRunAlive();
          if (alive) return false;
          send(frame({ type: "done" }));
          close();
          return true;
        },
        onError: () => {
          close();
        },
      });

      if (isClosed()) {
        stop();
        return;
      }

      p.log.debug(
        { runId: p.runId, since: p.since ?? FIRST_ID },
        "[runs] Attached a reader through the event store",
      );
    },
    cancel() {
      teardown?.();
    },
  });
}
