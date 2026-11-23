import { getConfiguration } from "../config/config";
import { saveConversationCompaction } from "../models/saveConversationCompaction";
import { CompactionUpdate } from "../types/Compaction";

export interface CompactionHandlerOptions {
  attempts?: number;
}

/**
 * Persists the rolled-up summary watermark after a turn.
 *
 * This runs inside the request that already produced the answer, so it must not
 * be able to fail it: the summary was written, the conversation is answerable,
 * and the only consequence of a lost watermark is re-summarizing next turn.
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
