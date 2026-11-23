import type { TailRunParams } from "../types";
import { readPage } from "./readPage";
import { FIRST_ID, REPLAY_BATCH } from "./shared";
import { touchStream } from "./touchStream";
import { waitForNext } from "./waitForNext";

/**
 * Attaches one reader to a run's log: replay what exists, then tail live.
 *
 * The replay-then-tail order is safe because the stream id is the cursor. A
 * snapshot read returns a `lastId`, and the live read starts from exactly that
 * id, so nothing appended in between can be skipped or duplicated — the property
 * an array index does not have.
 *
 * @returns a stop function. It only detaches this reader; it never aborts the
 *   run, matching `streamFromRun`'s `cancel()`.
 */
export function tailRun(params: TailRunParams): () => void {
  const { runId, onEvent, shouldStop, onIdle, onError, log } = params;
  let cursor = params.afterId ?? FIRST_ID;

  void (async () => {
    try {
      for (;;) {
        if (shouldStop()) return;
        const page = await readPage(runId, cursor);
        if (page.events.length === 0) break;
        cursor = page.lastId;
        for (let i = 0; i < page.events.length; i++) {
          if (shouldStop()) return;
          onEvent(page.events[i], page.ids[i]);
          if (page.events[i].type === "done" || page.events[i].type === "error")
            return;
        }
        if (page.events.length < REPLAY_BATCH) break;
      }

      while (!shouldStop()) {
        const next = await waitForNext(runId, cursor);
        if (shouldStop()) return;
        if (!next) {
          await touchStream(runId);
          if (shouldStop()) return;
          if (onIdle && (await onIdle())) return;
          continue;
        }
        cursor = next.lastId;
        for (let i = 0; i < next.events.length; i++) {
          if (shouldStop()) return;
          onEvent(next.events[i], next.ids[i]);
          if (next.events[i].type === "done" || next.events[i].type === "error")
            return;
        }
      }
    } catch (err) {
      log.warn({ err, runId }, "[runs] Stream tail stopped");
      onError?.(err);
    }
  })();

  return () => {
    // Nothing to tear down beyond the caller's own `shouldStop` flag; the
    // blocked read times out on its own within `BLOCK_MS`.
  };
}
