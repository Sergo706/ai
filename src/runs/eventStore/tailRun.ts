import type { TailRunParams } from "../types";
import { readPage } from "./readPage";
import { FIRST_ID, REPLAY_BATCH } from "./shared";
import { touchStream } from "./touchStream";
import { waitForNext } from "./waitForNext";

/**
 * Attach one reader to a run's log: replay what exists, then follow it live.
 *
 * Snapshot then live is safe because the cursor is a stream id: nothing appended
 * in between is skipped or duplicated.
 *
 * @param params - The run, the cursor, and the callbacks to report into.
 * @returns A stop function that only detaches this reader; it never aborts the
 * run.
 * @example
 * ```ts
 * const stop = tailRun({ runId, onEvent, shouldStop, log });
 * ```
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
