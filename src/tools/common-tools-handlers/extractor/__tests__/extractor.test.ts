import { MiniCache } from "@riavzon/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "~~/test/test-utils/config";

/**
 * The extractor tool, exercised end to end.
 *
 * `fetchLinkContent` is the only faked boundary: it is the outbound HTTP/media
 * fetch, which cannot run offline. Everything between it and the tool's return
 * value is real — `crawlPages`, `extractManyWithSummarize`, `extractWithSummarize`,
 * the sanitizer, the token chunker and the cache layer all execute, writing into
 * a real `MiniCache`, so the cache assertions read back what production wrote.
 */

const h = vi.hoisted(() => ({
  fetchLinkContent: vi.fn<(url: string, options: unknown) => Promise<unknown>>(),
}));

vi.mock("@steipete/summarize-core/content", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@steipete/summarize-core/content")>();
  return {
    ...actual,
    createLinkPreviewClient: () => ({ fetchLinkContent: h.fetchLinkContent }),
  };
});

type ExtractorModule = typeof import("../extractor.js");
type CacheModule = typeof import("../extractorCache.js");

interface Harness {
  extractor: ExtractorModule["extractor"];
  extractorCacheKey: CacheModule["extractorCacheKey"];
  store: MiniCache;
  cleanup: () => Promise<void>;
}

/**
 * `extractor()` reads the logger from the process-wide configuration, and the
 * cache helpers read the storage from it too, so the module has to be imported
 * after `loadConfig`.
 */
async function boot(): Promise<Harness> {
  const env = await loadConfig();
  const mod = (await import("../extractor.js"));
  const cacheMod = (await import("../extractorCache.js"));
  const store = env.mod.getStorage();
  if (!(store instanceof MiniCache)) {
    throw new Error("Expected the in-memory store for the units project");
  }
  // Storage is memoised per config module, so clearing here isolates each case.
  store.clear();
  return {
    extractor: mod.extractor,
    extractorCacheKey: cacheMod.extractorCacheKey,
    store,
    cleanup: env.cleanup,
  };
}

/**
 * A library-shaped extraction result. `fetchLinkContent` returns the raw
 * `ExtractedLinkContent`, not the tool's own shape, so the fixture has to carry
 * every field `usableContent` and `extractWithSummarize` read.
 */
function linkContent(
  url: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    url,
    title: "A title",
    description: "A description",
    siteName: "Example",
    // Comfortably above the 80-character `minContentCharacters` default, so a
    // case only reports "too short" when it deliberately asks for it.
    content:
      "Body text that is comfortably longer than the minimum threshold the extractor enforces by default.",
    truncated: false,
    totalCharacters: 101,
    wordCount: 16,
    transcriptCharacters: null,
    transcriptLines: null,
    transcriptWordCount: null,
    transcriptSource: null,
    transcriptionProvider: null,
    transcriptMetadata: null,
    transcriptSegments: null,
    transcriptTimedText: null,
    mediaDurationSeconds: null,
    sourceMetrics: null,
    video: null,
    isVideoOnly: false,
    diagnostics: {},
    ...overrides,
  };
}

const context = { toolCallId: "c", callIndex: 1, callTotal: 1 };

interface ToolResult {
  results: { url: string; markdown?: string; error?: string }[];
}

function errorCode(result: unknown): string {
  return (JSON.parse(result as string) as { error: { code: string } }).error
    .code;
}

beforeEach(() => {
  h.fetchLinkContent.mockReset();
  h.fetchLinkContent.mockImplementation((url: string) =>
    Promise.resolve(linkContent(url)),
  );
});

describe("extractor tool — validation", () => {
  it("rejects a missing urls array", async () => {
    const env = await boot();
    try {
      const result = await env.extractor(false)({}, context);
      expect(errorCode(result)).toBe("VALIDATION_ERROR");
      expect(h.fetchLinkContent).not.toHaveBeenCalled();
    } finally {
      await env.cleanup();
    }
  });

  it("rejects an empty urls array", async () => {
    const env = await boot();
    try {
      const result = await env.extractor(false)({ urls: [] }, context);
      expect(errorCode(result)).toBe("VALIDATION_ERROR");
    } finally {
      await env.cleanup();
    }
  });

  it("rejects a non-http url", async () => {
    const env = await boot();
    try {
      const result = await env.extractor(false)(
        { urls: ["ftp://example.com/file"] },
        context,
      );
      expect(errorCode(result)).toBe("VALIDATION_ERROR");
      expect(h.fetchLinkContent).not.toHaveBeenCalled();
    } finally {
      await env.cleanup();
    }
  });

  it("rejects a relative url", async () => {
    const env = await boot();
    try {
      const result = await env.extractor(false)({ urls: ["/page"] }, context);
      expect(errorCode(result)).toBe("VALIDATION_ERROR");
      expect(h.fetchLinkContent).not.toHaveBeenCalled();
    } finally {
      await env.cleanup();
    }
  });

  it("trims whitespace around a url before crawling", async () => {
    const env = await boot();
    try {
      await env.extractor(false)({ urls: ["  https://a.com  "] }, context);
      expect(h.fetchLinkContent.mock.calls[0]?.[0]).toBe("https://a.com");
    } finally {
      await env.cleanup();
    }
  });
});

describe("extractor tool — cache", () => {
  it("returns entirely from cache on a second identical call", async () => {
    const env = await boot();
    try {
      const tool = env.extractor(false);

      const first = (await tool({ urls: ["https://a.com"] }, context)) as ToolResult;
      const callsAfterFirst = h.fetchLinkContent.mock.calls.length;
      const second = (await tool({ urls: ["https://a.com"] }, context)) as ToolResult;

      expect(callsAfterFirst).toBe(1);
      // The second call must not have fetched again: that is the point of the
      // cache, and it is only provable by the fetch count staying put.
      expect(h.fetchLinkContent).toHaveBeenCalledTimes(1);
      expect(second.results[0]?.markdown).toBe(first.results[0]?.markdown);
    } finally {
      await env.cleanup();
    }
  });

  it("stores the crawled markdown under the full prefix when limiting is off", async () => {
    const env = await boot();
    try {
      await env.extractor(false)({ urls: ["https://a.com"] }, context);

      const key = env.extractorCacheKey("https://a.com", "ext:full:");
      const raw = env.store.get(key) as string | null;
      expect(raw).not.toBeNull();
    expect(JSON.parse(String(raw))).toEqual({
        url: "https://a.com",
        markdown: expect.stringContaining("Body text"),
      });
    } finally {
      await env.cleanup();
    }
  });

  it("uses a distinct prefix when token limiting is on", async () => {
    const env = await boot();
    try {
      await env.extractor(true)({ urls: ["https://a.com"] }, context);

      const limitedKey = env.extractorCacheKey("https://a.com", "ext:lim:");
      const fullKey = env.extractorCacheKey("https://a.com", "ext:full:");
      expect(env.store.get(limitedKey)).not.toBeNull();
      expect(env.store.get(fullKey)).toBeNull();
    } finally {
      await env.cleanup();
    }
  });

  it("serves a warm cache without fetching", async () => {
    const env = await boot();
    try {
      env.store.set(
        env.extractorCacheKey("https://a.com", "ext:full:"),
        JSON.stringify({ url: "https://a.com", markdown: "# Cached" }),
        60_000,
      );

      const result = (await env.extractor(false)(
        { urls: ["https://a.com"] },
        context,
      )) as ToolResult;

      expect(result.results[0]?.markdown).toBe("# Cached");
      expect(h.fetchLinkContent).not.toHaveBeenCalled();
    } finally {
      await env.cleanup();
    }
  });

  it("crawls only the misses and keeps the cached entry out of the fetch list", async () => {
    const env = await boot();
    try {
      env.store.set(
        env.extractorCacheKey("https://a.com", "ext:full:"),
        JSON.stringify({ url: "https://a.com", markdown: "# Cached" }),
        60_000,
      );

      const result = (await env.extractor(false)(
        { urls: ["https://a.com", "https://b.com"] },
        context,
      )) as ToolResult;

      expect(h.fetchLinkContent).toHaveBeenCalledTimes(1);
      expect(h.fetchLinkContent.mock.calls[0]?.[0]).toBe("https://b.com");
      expect(result.results[0]?.markdown).toBe("# Cached");
    } finally {
      await env.cleanup();
    }
  });

  it("preserves the caller's url order even when the fetch resolves out of order", async () => {
    const env = await boot();
    try {
      h.fetchLinkContent.mockImplementation((url: string) => {
        // Make the first requested url resolve last.
        const delay = url === "https://a.com" ? 30 : 0;
        const marker = url === "https://a.com" ? "FIRST" : "SECOND";
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(
              linkContent(url, {
                // Bare urls are stripped by the sanitiser, so the marker has to
                // be a word rather than the url itself.
                content: `Body for the ${marker} page, long enough to clear the minimum character threshold easily.`,
              }),
            );
          }, delay);
        });
      });

      const result = (await env.extractor(false)(
        { urls: ["https://a.com", "https://b.com"] },
        context,
      )) as ToolResult;

      expect(result.results.map((item) => item.url)).toEqual([
        "https://a.com",
        "https://b.com",
      ]);
      expect(result.results[0]?.markdown).toContain("FIRST");
      expect(result.results[1]?.markdown).toContain("SECOND");
    } finally {
      await env.cleanup();
    }
  });
});

describe("extractor tool — crawl results", () => {
  it("reports a failed page without leaking the crawler's message", async () => {
    const env = await boot();
    try {
      h.fetchLinkContent.mockRejectedValue(new Error("connection refused"));

      const result = (await env.extractor(false)(
        { urls: ["https://a.com"] },
        context,
      )) as ToolResult;

      // The tool does not surface the transport error verbatim: a page with no
      // markdown is reported with one stable message so the model cannot echo
      // internal failure text back to the user.
      expect(result.results[0]?.url).toBe("https://a.com");
      expect(result.results[0]?.error).toBe("No usable markdown was extracted.");
      expect(result.results[0]?.markdown).toBeUndefined();
    } finally {
      await env.cleanup();
    }
  });

  it("reports a page whose body is below the minimum as having no markdown", async () => {
    const env = await boot();
    try {
      h.fetchLinkContent.mockImplementation((url: string) =>
        Promise.resolve(linkContent(url, { content: "tiny" })),
      );

      const result = (await env.extractor(false)(
        { urls: ["https://a.com"] },
        context,
      )) as ToolResult;

      expect(result.results[0]?.error).toBe("No usable markdown was extracted.");
    } finally {
      await env.cleanup();
    }
  });

  it("does not cache a page that failed", async () => {
    const env = await boot();
    try {
      h.fetchLinkContent.mockRejectedValue(new Error("boom"));

      await env.extractor(false)({ urls: ["https://a.com"] }, context);

      expect(
        env.store.get(env.extractorCacheKey("https://a.com", "ext:full:")),
      ).toBeNull();
    } finally {
      await env.cleanup();
    }
  });

  it("matches the real crawler shape rather than a wrap-response schema", async () => {
    const env = await boot();
    try {
      // Regression guard: `crawlPages` hands the tool `CrawledPage` objects
      // (`ok`/`content`). Validating them against the library's scraping shape
      // (`success`/`markdown`) rejected every real crawl and turned the tool into
      // a permanent EXTRACTION_FAILED, so this asserts the real path succeeds.
      const result = (await env.extractor(false)(
        { urls: ["https://a.com"] },
        context,
      )) as ToolResult;

      expect(result.results[0]?.markdown).toContain("Body text");
      expect(result.results[0]?.error).toBeUndefined();
    } finally {
      await env.cleanup();
    }
  });

  it("treats a non-HTML payload with a real body as usable", async () => {
    const env = await boot();
    try {
      h.fetchLinkContent.mockImplementation((url: string) =>
        Promise.resolve(linkContent(url, { title: null, description: null })),
      );

      const result = (await env.extractor(false)(
        { urls: ["https://a.com"] },
        context,
      )) as ToolResult;

      // A blank title must not sink the page: the url stands in for it.
      expect(result.results[0]?.markdown).toContain("Body text");
    } finally {
      await env.cleanup();
    }
  });
});

describe("extractor tool — sanitisation", () => {
  it("strips images, link targets and bare urls from the stored markdown", async () => {
    const env = await boot();
    try {
      h.fetchLinkContent.mockImplementation((url: string) =>
        Promise.resolve(
          linkContent(url, {
            content:
              "# Title\n\n![alt](https://img.example/x.png)\n\n[click here](https://example.com/target)\n\nVisit https://bare.example/path for more.",
          }),
        ),
      );

      await env.extractor(false)({ urls: ["https://a.com"] }, context);

      const raw = env.store.get(
        env.extractorCacheKey("https://a.com", "ext:full:"),
      ) as string;
      const stored = JSON.parse(raw) as { markdown: string };

      expect(stored.markdown).not.toContain("img.example");
      expect(stored.markdown).not.toContain("https://example.com/target");
      expect(stored.markdown).not.toContain("https://bare.example/path");
      // The link *text* survives even though the target is gone.
      expect(stored.markdown).toContain("click here");
    } finally {
      await env.cleanup();
    }
  });
});

describe("extractor tool — token limiting", () => {
  it("returns the body untouched when limiting is off", async () => {
    const env = await boot();
    try {
      const body =
        "word " +
        "word ".repeat(199) +
        "tail";
      h.fetchLinkContent.mockImplementation((url: string) =>
        Promise.resolve(linkContent(url, { content: body })),
      );

      const result = (await env.extractor(false)(
        { urls: ["https://a.com"] },
        context,
      )) as ToolResult;

      // `usableContent` trims the extracted body, so the expected value is the
      // trimmed input rather than the raw string.
      expect(result.results[0]?.markdown).toBe(body.trim());
      expect(result.results[0]?.markdown).not.toContain("[...Content");
    } finally {
      await env.cleanup();
    }
  });

  it("truncates to the token budget and notes the truncation", async () => {
    const env = await boot();
    try {
      // 4 characters per estimated token, so 400_000 characters is far past a
      // 100-token budget.
      h.fetchLinkContent.mockImplementation((url: string) =>
        Promise.resolve(linkContent(url, { content: "a".repeat(400_000) })),
      );

      const result = (await env.extractor(
        true,
        100,
      )({ urls: ["https://a.com"] }, context)) as ToolResult;

      const markdown = result.results[0]?.markdown ?? "";
      expect(markdown).toContain("[...Content truncated due to length limits...]");
      // The kept part must be much smaller than the input.
      expect(markdown.length).toBeLessThan(10_000);
    } finally {
      await env.cleanup();
    }
  });

  it("does not append the truncation note when the body fits", async () => {
    const env = await boot();
    try {
      const body =
        "A body long enough to clear the minimum character threshold but far short of any token budget.";
      h.fetchLinkContent.mockImplementation((url: string) =>
        Promise.resolve(linkContent(url, { content: body })),
      );

      const result = (await env.extractor(
        true,
        10_000,
      )({ urls: ["https://a.com"] }, context)) as ToolResult;

      expect(result.results[0]?.markdown).toBe(body);
      expect(result.results[0]?.markdown).not.toContain("[...Content");
    } finally {
      await env.cleanup();
    }
  });
});

describe("extractor tool — formatter", () => {
  it("applies the formatter to the extracted markdown", async () => {
    const env = await boot();
    try {
      const formatter = vi.fn((title: string, raw: string) =>
        `# ${title}\n\n${raw}`,
      );

      const result = (await env.extractor(false, 50_000, 86_400, formatter)(
        { urls: ["https://a.com"] },
        context,
      )) as ToolResult;

      expect(formatter).toHaveBeenCalledTimes(1);
      expect(formatter.mock.calls[0]?.[0]).toBe("A title");
      expect(result.results[0]?.markdown).toContain("# A title");
    } finally {
      await env.cleanup();
    }
  });

  it("falls back to the url when the page has no title", async () => {
    const env = await boot();
    try {
      h.fetchLinkContent.mockImplementation((url: string) =>
        Promise.resolve(linkContent(url, { title: "" })),
      );
      const formatter = vi.fn((title: string, raw: string) => `${title}|${raw}`);

      await env.extractor(false, 50_000, 86_400, formatter)(
        { urls: ["https://a.com"] },
        context,
      );

      // `extractWithSummarize` substitutes the url for a blank title.
      expect(formatter.mock.calls[0]?.[0]).toBe("https://a.com");
    } finally {
      await env.cleanup();
    }
  });
});

describe("extractor tool — transcript pages", () => {
  it("prefers a longer transcript over the page body", async () => {
    const env = await boot();
    try {
      h.fetchLinkContent.mockImplementation((url: string) =>
        Promise.resolve(
          linkContent(url, {
            content: "short page",
            // Long enough to clear the 80-character minimum on its own, so this
            // only proves the longer-source preference.
            transcriptTimedText:
              "a much longer transcript body than the page, transcribed from the video track by yt-dlp",
            transcriptSource: "yt-dlp",
          }),
        ),
      );

      const result = (await env.extractor(false)(
        { urls: ["https://a.com"] },
        context,
      )) as ToolResult;

      expect(result.results[0]?.markdown).toBe(
        "a much longer transcript body than the page, transcribed from the video track by yt-dlp",
      );
    } finally {
      await env.cleanup();
    }
  });
});
