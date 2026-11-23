import type {
  ExtractorCacheEntry,
  ExtractorCachePrefix,
  ExtractorCacheRead,
  ExtractorCacheWrite,
} from "./schema";
import { generateHash } from "../../../utils/hash";
import {
  cacheGetMany,
  cacheSetMany,
  getConfiguration,
} from "../../../config/config";

export function extractorCacheKey(
  url: string,
  prefix: ExtractorCachePrefix,
): string {
  return `${prefix}${generateHash(url.trim())}`;
}

export async function readExtractorCache(
  urls: readonly string[],
  prefix: ExtractorCachePrefix,
): Promise<ExtractorCacheRead> {
  const log = getConfiguration().logger;
  const cacheKeys = urls.map((url) => extractorCacheKey(url, prefix));
  log.debug({ urls, cacheKeys, prefix }, "Extractor cache keys computed");

  const cachedValues = await cacheGetMany(cacheKeys);
  const resultsByUrl = new Map<string, ExtractorCacheEntry>();
  const urlsToCrawl: string[] = [];

  urls.forEach((url, index) => {
    const raw = cachedValues[index];

    if (!raw) {
      log.debug({ url, key: cacheKeys[index] }, "Extractor cache MISS");
      urlsToCrawl.push(url);
      return;
    }

    try {
      const entry = JSON.parse(raw) as ExtractorCacheEntry;
      if (entry.markdown) {
        log.debug(
          { url, key: cacheKeys[index], chars: entry.markdown.length },
          "Extractor cache HIT",
        );
        resultsByUrl.set(url, entry);
        return;
      }
      log.warn(
        { url, key: cacheKeys[index] },
        "Extractor cache entry has no markdown; re-crawling",
      );
    } catch {
      log.warn(
        { cacheKey: cacheKeys[index] },
        "Discarding unparseable extractor cache entry.",
      );
    }

    urlsToCrawl.push(url);
  });

  return { resultsByUrl, urlsToCrawl };
}

export async function writeExtractorCache(
  entries: readonly ExtractorCacheWrite[],
  prefix: ExtractorCachePrefix,
  ttlSeconds: number,
): Promise<void> {
  if (entries.length === 0) return;

  await cacheSetMany(
    entries.map((entry) => ({
      key: extractorCacheKey(entry.url, prefix),
      value: JSON.stringify({ url: entry.url, markdown: entry.markdown }),
    })),
    ttlSeconds * 1000,
  );

  getConfiguration().logger.debug(
    { cachedCount: entries.length },
    "Extractor cache entries written",
  );
}
