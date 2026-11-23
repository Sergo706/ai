import { getConfiguration } from "../../../../../config/config";
import { extractWithSummarize } from "./extractWithSummarize";
import { NotExtractableError } from "./summarizeErrors";
import type { ExtractOptions, SummarizeOutcome } from "./types.js";

/**
 * Extract many URLs, keeping the failures.
 *
 * A batch is used by the crawler, where one dead URL must not sink the rest.
 * Rejections are returned rather than thrown so the caller can decide whether
 * "every URL was too short" is fatal.
 */
export async function extractManyWithSummarize(
  urls: string[],
  options: ExtractOptions = {},
): Promise<SummarizeOutcome[]> {
  const log = getConfiguration().logger;

  return await Promise.all(
    urls.map(async (url): Promise<SummarizeOutcome> => {
      try {
        return {
          url,
          ok: true,
          value: await extractWithSummarize(url, options),
        };
      } catch (error: unknown) {
        if (error instanceof NotExtractableError) {
          log.debug(
            { url, reason: error.reason },
            "[summarize] Not HTML, skipping",
          );
        } else {
          log.warn({ url, err: error }, "[summarize] Extraction failed");
        }
        return { url, ok: false, error };
      }
    }),
  );
}
