import {
  extractorParams,
  type ExtractorCachePrefix,
  type ExtractorCacheWrite,
} from "./schema";
import { readExtractorCache, writeExtractorCache } from "./extractorCache";
import { sanitizeExtractedMarkdown } from "./sanitizeExtractedMarkdown";
import { toolError } from "../../execution";
import { ToolHandler } from "../../../types/ToolExecutionTypes";
import { chunkByTokens } from "../../../utils/chunkTextByTokens";
import { getConfiguration } from "../../../config/config";
import { envInt } from "@riavzon/utils/server";
import { crawlPages } from "./handler/customCrawl";

export function extractor(
  limitDataTokens: boolean,
  EXTRACTOR_MAX_CONTENT_TOKENS = envInt(
    "EXTRACTOR_MAX_CONTENT_TOKENS",
    50_000,
    { min: 1000 },
  ),
  EXTRACTOR_CACHE_TTL_SECONDS = envInt("EXTRACTOR_CACHE_TTL_SECONDS", 86_400, {
    min: 0,
  }),
  formatter?: (title: string, rawText: string) => string,
): ToolHandler {
  const log = getConfiguration().logger;

  return async (args) => {
    log.debug({ args }, "agent ran tool extractor");
    const parse = extractorParams.safeParse(args);
    if (!parse.success) {
      return toolError("VALIDATION_ERROR", JSON.stringify(parse.error.issues));
    }

    try {
      const urls = parse.data.urls.map((u) => u.trim());
      const prefix: ExtractorCachePrefix = limitDataTokens
        ? "ext:lim:"
        : "ext:full:";

      const { resultsByUrl, urlsToCrawl } = await readExtractorCache(
        urls,
        prefix,
      );

      if (urlsToCrawl.length === 0) {
        log.debug({ urls }, "Extractor 100% Redis cache HIT");
        return { results: urls.map((u) => resultsByUrl.get(u)) };
      }

      log.debug(
        { requested: urls.length, crawling: urlsToCrawl.length, urlsToCrawl },
        "Extractor dispatching crawl",
      );
      const crawlStartedAt = Date.now();
      const res = await crawlPages(urlsToCrawl, log);
      log.debug(
        {
          crawled: urlsToCrawl.length,
          durationMs: Date.now() - crawlStartedAt,
          status: Boolean(res),
        },
        "Extractor crawl finished",
      );

      const pages = Array.isArray(res) ? res : [];

      const cacheWrites: ExtractorCacheWrite[] = [];

      for (const result of pages) {
        const rawMarkdown = result.content.trim();

        if (!result.ok || !rawMarkdown) {
          log.info({ url: result.url }, "No usable markdown was extracted.");
          resultsByUrl.set(result.url, {
            url: result.url,
            error: "No usable markdown was extracted.",
          });
          continue;
        }

        const title = result.title?.trim() ?? "";

        const markdownToProcess = sanitizeExtractedMarkdown(rawMarkdown);
        let fullFormattedContent: string = markdownToProcess;

        if (formatter) {
          fullFormattedContent = formatter(title, markdownToProcess);
        }

        let finalOutput = fullFormattedContent;
        if (limitDataTokens) {
          const safeChunks = chunkByTokens(
            fullFormattedContent,
            EXTRACTOR_MAX_CONTENT_TOKENS,
            0,
          );
          finalOutput = safeChunks[0] || "";

          if (safeChunks.length > 1) {
            finalOutput += "\n\n[...Content truncated due to length limits...]";
          }
        }

        const itemPayload = {
          url: result.url,
          markdown: finalOutput,
        };
        resultsByUrl.set(result.url, itemPayload);
        cacheWrites.push(itemPayload);
      }

      await writeExtractorCache(
        cacheWrites,
        prefix,
        EXTRACTOR_CACHE_TTL_SECONDS,
      );

      return {
        results: urls.map(
          (u) =>
            resultsByUrl.get(u) ?? {
              url: u,
              error: "No usable markdown was extracted.",
            },
        ),
      };
    } catch (err) {
      log.error({ err }, "Unable to extract page content.");
      return toolError("EXTRACTION_FAILED", "Unable to extract page content.");
    }
  };
}
