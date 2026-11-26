import {
  ContentTooShortError,
  ExtractionDeadlineError,
  NotExtractableError,
} from "./summarizeErrors";
import type { ExtractOptions, SummarizeExtraction } from "./types";
import { summarizeClient } from "./client";
import { trimmedOr, trimmedOrNull, usableContent } from "./utils";
import { getConfiguration } from "../../../../../config/config";
import { loadPeer } from "../../../../../utils/loadPeerDepend";

type ContentPeer = typeof import("@steipete/summarize-core/content");

/**
 * Extract one URL.
 *
 * Tuning comes from `config.extractor`, so a consumer that never sets it still
 * gets the documented defaults rather than a hard failure. Call-site options
 * win over both, which keeps a one-off override from mutating global state.
 *
 * @throws {NotExtractableError} when the payload is not HTML at all — a PDF,
 * image or archive. The library rejects those before extracting, so there is
 * nothing to retry: the caller should route the URL to a layer that can parse
 * it.
 * @throws {ContentTooShortError} when the page yields less than
 * `minCharacters` of text. Callers should treat that as "this layer found
 * nothing" and fall through to the next one.
 * @throws {ExtractionDeadlineError} when the URL ran past `deadlineMs`. The
 * caller should fall through to the next layer exactly as it does for a
 * too-short page — a slow page is not a binary one.
 */
export async function extractWithSummarize(
  url: string,
  options: ExtractOptions = {},
): Promise<SummarizeExtraction> {
  const { logger, extractor } = getConfiguration();
  const log = logger;

  const {
    minCharacters = extractor?.minContentCharacters ?? 80,
    deadlineMs = extractor?.deadlineMs ?? 0,
    ...fetchOptions
  } = options;

  const started = Date.now();
  const client = await summarizeClient();
  const pending = client.fetchLinkContent(url, {
    timeoutMs: extractor?.timeoutMs ?? 120_000,
    maxCharacters: extractor?.maxCharacters ?? Number.POSITIVE_INFINITY,
    format: "markdown",
    markdownMode: "readability",
    youtubeTranscript: "auto",
    mediaTranscript: "auto",
    transcriptTimestamps: false,
    throwOnAssetLikeHtmlError: true,
    ...fetchOptions,
  });
  void pending.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline =
    deadlineMs > 0
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ExtractionDeadlineError(url, deadlineMs));
          }, deadlineMs);
        })
      : null;

  let extracted;
  try {
    extracted = await (deadline === null
      ? pending
      : Promise.race([pending, deadline]));
  } catch (error: unknown) {
    if (error instanceof ExtractionDeadlineError) {
      log.warn(
        { url, deadlineMs },
        "[summarize] Extraction exceeded its deadline, handing off",
      );
      throw error;
    }
    const { isAssetLikeHtmlFetchError } = await loadPeer<ContentPeer>(
      "@steipete/summarize-core/content",
      "the extractor tool",
    );
    if (isAssetLikeHtmlFetchError(error)) {
      log.debug(
        { url, reason: error.reason },
        "[summarize] Payload is not extractable, handing off to the next layer",
      );
      throw new NotExtractableError(url, error.reason);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const { text, fromTranscript } = usableContent(extracted);
  const characters = text.length;

  if (characters < minCharacters) {
    log.debug(
      {
        url,
        characters,
        minCharacters,
        truncated: extracted.truncated,
        video: extracted.video,
        transcriptSource: extracted.transcriptSource,
        diagnostics: extracted.diagnostics,
      },
      "[summarize] Extracted content is too short to use",
    );
    throw new ContentTooShortError(url, characters, minCharacters);
  }

  log.debug(
    {
      url,
      characters,
      fromTranscript,
      transcriptSource: extracted.transcriptSource,
      truncated: extracted.truncated,
      elapsedMs: Date.now() - started,
    },
    "[summarize] Extraction succeeded",
  );

  return {
    url: extracted.url,
    title: trimmedOr(extracted.title, url),
    content: text,
    description: trimmedOrNull(extracted.description),
    siteName: trimmedOrNull(extracted.siteName),
    wordCount: fromTranscript
      ? (extracted.transcriptWordCount ?? extracted.wordCount)
      : extracted.wordCount,
    truncated: extracted.truncated,
    characters,
    fromTranscript,
    transcriptSource: extracted.transcriptSource,
    videoUrl: extracted.video?.url ?? null,
    raw: extracted,
  };
}
