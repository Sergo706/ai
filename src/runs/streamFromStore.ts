import { encode, frame, SSE_HEARTBEAT } from "../chat/sse";
import { StoredEvent } from "../types/Chat";
import { FIRST_ID, tailRun } from "./eventStore";
import type { StreamFromStoreParams } from "./types";

/**
 * The cross-replica counterpart to `streamFromRun`.
 *
 * `streamFromRun` reads a `RunHandle` in this process's memory. That works only
 * while the replica that started the run is also the replica serving the
 * reader. `streamFromStore` reads the Redis Stream instead, so any replica can
 * serve any run — which is the entire reason a load balancer in front of the
 * service is safe.
 *
 * The `since` cursor is a stream id rather than an array index. A client that
 * reconnects passes back the last id it saw and gets exactly the events after
 * it, even across a replica change.
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
