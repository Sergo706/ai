import { getConfiguration } from "../config/config";
import { saveConversationCompaction } from "../models/saveConversationCompaction";
import { CompactionUpdate } from "../types/Compaction";

/** Tuning for {@link makeCompactionHandler}. */
export interface CompactionHandlerOptions {
  /**
   * Write attempts before giving up; the turn continues either way.
   *
   * @default 2
   */
  attempts?: number;
}

/**
 * Create the hook that records a compaction result after a turn.
 *
 * Never throws: a write failure is logged and the turn still completes.
 *
 * @param convId - Conversation the summary belongs to.
 * @param options - Write retry count.
 * @returns A handler that takes one `CompactionUpdate`.
 */
export function makeCompactionHandler(
  convId: number,
  { attempts = 2 }: CompactionHandlerOptions = {},
) {
  const log = getConfiguration().logger;
  return async (update: CompactionUpdate): Promise<void> => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const saved = await saveConversationCompaction(convId, update);
        log.info(
          { convId, throughMessageId: update.throughMessageId, saved },
          saved
            ? "Conversation compacted"
            : "Compaction computed but watermark not persisted",
        );
        return;
      } catch (error) {
        const last = attempt === attempts;
        log[last ? "error" : "warn"](
          { err: error, convId, attempt, attempts },
          last
            ? "Failed to persist compaction; the turn continues without it"
            : "Compaction write failed; retrying",
        );
      }
    }
  };
}
