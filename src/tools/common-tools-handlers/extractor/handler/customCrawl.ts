import type { Logger } from "../../../../config/configSchema";
import { extractManyWithSummarize } from "./summarize/extractManyWithSummarize";
import { NotExtractableError } from "./summarize/summarizeErrors";
import type { SummarizeExtraction } from "./summarize/types";

/**
 * One page's outcome after extraction, in the shape the tool returns.
 */
export interface CrawledPage {
  url: string;
  ok: boolean;
  title: string | null;
  content: string;
  description: string | null;
  siteName: string | null;
  wordCount: number;
  truncated: boolean;
  fromTranscript: boolean;
  videoUrl: string | null;
  /** Present only when `ok` is false. */
  error?: string;
}

function toCrawledPage(extraction: SummarizeExtraction): CrawledPage {
  return {
    url: extraction.url,
    ok: true,
    title: extraction.title,
    content: extraction.content,
    description: extraction.description,
    siteName: extraction.siteName,
    wordCount: extraction.wordCount,
    truncated: extraction.truncated,
    fromTranscript: extraction.fromTranscript,
    videoUrl: extraction.videoUrl,
  };
}

export async function crawlPages(
  urls: readonly string[],
  log: Logger,
): Promise<CrawledPage[]> {
  if (urls.length === 0) return [];

  const outcomes = await extractManyWithSummarize([...urls]);

  const pages = outcomes.map((outcome): CrawledPage => {
    if (outcome.ok) return toCrawledPage(outcome.value);

    return {
      url: outcome.url,
      ok: false,
      title: null,
      content: "",
      description: null,
      siteName: null,
      wordCount: 0,
      truncated: false,
      fromTranscript: false,
      videoUrl: null,
      error:
        outcome.error instanceof NotExtractableError
          ? `Not extractable: ${outcome.error.reason}`
          : outcome.error instanceof Error
            ? outcome.error.message
            : "Extraction failed",
    };
  });

  const failed = pages.filter((page) => !page.ok).length;

  if (failed > 0) {
    log.warn(
      { urls, failed, total: pages.length },
      "[crawl] Some URLs could not be extracted",
    );
  } else {
    log.info({ urls }, "[crawl] Crawl completed");
  }

  return pages;
}
