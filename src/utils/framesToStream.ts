import type { SseFrame } from "../types/Chat";
import { encode, frame, SSE_HEARTBEAT } from "../chat/sse";

export interface FramesToStreamOptions {
  /** Comment frame sent while nothing is being produced. Defaults to 10s. */
  heartbeatMs?: number;
  /**
   * Called when the reader goes away.
   *
   * Pass `() => controller.abort()` for the `AbortSignal` given to `chat()`
   * when a dropped client should end the turn. Omit it when the turn is also
   * being written to a run the client can reattach to.
   */
  onCancel?: () => void;
}

/**
 * Turns the frames of a turn into a Server-Sent Events body.
 *
 * This is the runs-off path: `chat()` returns `ChatStream.frames` whenever the
 * run system is not configured, and the caller decides whether that becomes an
 * SSE response, a WebSocket message stream, or CLI output. Keep it out of
 * `chat()` so a caller that wants none of those never pays for it.
 *
 * The runs-on path does not use this: there the response is `streamFromRun`,
 * which replays the run's own log and then follows it live.
 */
export function framesToStream(
  frames: AsyncIterable<SseFrame>,
  options: FramesToStreamOptions = {},
): ReadableStream<Uint8Array> {
  let closed = false;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  /**
   * Held explicitly so `cancel()` can end the producer.
   *
   * A reader that disconnects while the loop is parked on `next()` leaves that
   * await pending until the turn produces another event, so nothing would ever
   * release the generator. `return()` resolves the pending `next()` as done,
   * which is the only way to unwind it from outside.
   */
  let iterator: AsyncIterator<SseFrame> | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (keepAlive !== undefined) clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          // Already closed by the reader going away.
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

      keepAlive = setInterval(() => {
        send(SSE_HEARTBEAT);
      }, options.heartbeatMs ?? 10_000);

      (keepAlive as { unref?: () => void }).unref?.();

      iterator = frames[Symbol.asyncIterator]();

      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done === true || closed) break;
          send(frame(next.value));
        }
      } catch {
        // The turn reports its own failures through an `error` frame.
      } finally {
        close();
      }
    },
    cancel() {
      closed = true;
      if (keepAlive !== undefined) clearInterval(keepAlive);
      void iterator?.return?.();
      options.onCancel?.();
    },
  });
}
