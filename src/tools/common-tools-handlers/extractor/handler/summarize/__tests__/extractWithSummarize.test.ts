import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AssetLikeHtmlFetchError,
  type ExtractedLinkContent,
} from "@steipete/summarize-core/content";

/**
 * The extraction layer is exercised against a stubbed client, not the real
 * library: the real one shells out to yt-dlp/whisper.cpp/ffmpeg and hits the
 * network, which a unit test must not do. What is tested here is our own
 * contract — configuration, the usability floor, and the adaptation into
 * `CrawlResultItem` — because that is the part this repo owns.
 */

const h = vi.hoisted(() => ({
  fetchLinkContent: vi.fn<(url: string, opts?: unknown) => Promise<unknown>>(),
  createLinkPreviewClient: vi.fn(),
}));

vi.mock("@steipete/summarize-core/content", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    createLinkPreviewClient: h.createLinkPreviewClient,
  };
});

import { extractManyWithSummarize } from "../extractManyWithSummarize.js";
import { extractWithSummarize } from "../extractWithSummarize.js";
import { resetSummarizeClient } from "../client.js";
import {
  ContentTooShortError,
  ExtractionDeadlineError,
  NotExtractableError,
} from "../summarizeErrors.js";
import { libLog } from "~~/test/test-utils/logger.js";

function extracted(
  overrides: Partial<ExtractedLinkContent> = {},
): ExtractedLinkContent {
  return {
    url: "https://example.com/article",
    title: "An article",
    description: "A description",
    siteName: "Example",
    content: "x".repeat(500),
    truncated: false,
    totalCharacters: 500,
    wordCount: 80,
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
    diagnostics: {} as ExtractedLinkContent["diagnostics"],
    ...overrides,
  };
}

beforeEach(() => {
  h.fetchLinkContent.mockReset();
  h.createLinkPreviewClient.mockReset();
  h.createLinkPreviewClient.mockReturnValue({
    fetchLinkContent: h.fetchLinkContent,
  });
  resetSummarizeClient();
  vi.clearAllMocks();
});

describe("extractWithSummarize", () => {
  it("passes the URL and our budgets to the library", async () => {
    h.fetchLinkContent.mockResolvedValue(extracted());

    await extractWithSummarize("https://example.com/article");

    const [url, options] = h.fetchLinkContent.mock.calls[0];
    expect(url).toBe("https://example.com/article");
    expect(options).toMatchObject({
      format: "markdown",
      markdownMode: "readability",
      youtubeTranscript: "auto",
      mediaTranscript: "auto",
      transcriptTimestamps: false,
      throwOnAssetLikeHtmlError: true,
    });
  });

  it("throws when the body is under the character floor", async () => {
    h.fetchLinkContent.mockResolvedValue(
      extracted({ content: "enable javascript", title: "Just a moment" }),
    );

    await expect(
      extractWithSummarize("https://example.com"),
    ).rejects.toBeInstanceOf(ContentTooShortError);
  });

  it("reports the counts on the too-short error", async () => {
    h.fetchLinkContent.mockResolvedValue(extracted({ content: "abc" }));

    const error = await extractWithSummarize("https://example.com", {
      minCharacters: 50,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContentTooShortError);
    expect((error as ContentTooShortError).characters).toBe(3);
    expect((error as ContentTooShortError).minimum).toBe(50);
    expect((error as ContentTooShortError).url).toBe("https://example.com");
  });

  it("honours a per-call minimum instead of the configured one", async () => {
    h.fetchLinkContent.mockResolvedValue(
      extracted({ content: "x".repeat(20) }),
    );

    await expect(
      extractWithSummarize("https://example.com", {
        minCharacters: 10,
      }),
    ).resolves.toMatchObject({ characters: 20 });
  });

  it("prefers the transcript when it is longer than the page body", async () => {
    h.fetchLinkContent.mockResolvedValue(
      extracted({
        content: "short page",
        transcriptTimedText: "w".repeat(900),
        transcriptWordCount: 150,
        transcriptSource: "yt-dlp",
        video: { kind: "youtube", url: "https://youtube.com/watch?v=abc" },
      }),
    );

    const result = await extractWithSummarize(
      "https://youtube.com/watch?v=abc",
    );

    expect(result.content).toHaveLength(900);
    expect(result.fromTranscript).toBe(true);
    expect(result.transcriptSource).toBe("yt-dlp");
    expect(result.videoUrl).toBe("https://youtube.com/watch?v=abc");
    expect(result.wordCount).toBe(150);
  });

  it("keeps the page body when it is the longer of the two", async () => {
    h.fetchLinkContent.mockResolvedValue(
      extracted({
        content: "p".repeat(800),
        transcriptTimedText: "t".repeat(100),
      }),
    );

    const result = await extractWithSummarize("https://example.com");

    expect(result.fromTranscript).toBe(false);
    expect(result.content).toHaveLength(800);
  });

  it("counts words from the page when the transcript has no word count", async () => {
    h.fetchLinkContent.mockResolvedValue(
      extracted({
        content: "short page",
        transcriptTimedText: "w".repeat(900),
        transcriptWordCount: null,
        wordCount: 42,
      }),
    );

    const result = await extractWithSummarize("https://example.com");

    expect(result.fromTranscript).toBe(true);
    expect(result.wordCount).toBe(42);
  });

  it("falls back to the URL when the page has no title", async () => {
    h.fetchLinkContent.mockResolvedValue(extracted({ title: "   " }));

    const result = await extractWithSummarize("https://example.com/page");

    expect(result.title).toBe("https://example.com/page");
  });

  it("treats blank metadata as absent rather than empty strings", async () => {
    h.fetchLinkContent.mockResolvedValue(
      extracted({ description: "  ", siteName: "" }),
    );

    const result = await extractWithSummarize("https://example.com");

    expect(result.description).toBeNull();
    expect(result.siteName).toBeNull();
  });

  it("builds the client once across calls", async () => {
    h.fetchLinkContent.mockResolvedValue(extracted());

    await extractWithSummarize("https://a.com");
    await extractWithSummarize("https://b.com");

    expect(h.createLinkPreviewClient).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the client after a reset", async () => {
    h.fetchLinkContent.mockResolvedValue(extracted());

    await extractWithSummarize("https://a.com");
    resetSummarizeClient();
    await extractWithSummarize("https://b.com");

    expect(h.createLinkPreviewClient).toHaveBeenCalledTimes(2);
  });

  it("propagates library failures unchanged", async () => {
    const failure = new Error("dns blocked");
    h.fetchLinkContent.mockRejectedValue(failure);

    await expect(extractWithSummarize("https://x.com")).rejects.toBe(failure);
  });
});

describe("extractManyWithSummarize", () => {
  it("keeps the failures and returns the successes", async () => {
    h.fetchLinkContent.mockImplementation((url: string) =>
      url === "https://good.com"
        ? Promise.resolve(extracted({ url }))
        : Promise.resolve(extracted({ url, content: "" })),
    );

    const outcomes = await extractManyWithSummarize([
      "https://good.com",
      "https://bad.com",
    ]);

    expect(outcomes[0]).toMatchObject({ url: "https://good.com", ok: true });
    expect(outcomes[1]).toMatchObject({ url: "https://bad.com", ok: false });
    expect((outcomes[1] as { error: unknown }).error).toBeInstanceOf(
      ContentTooShortError,
    );
  });

  it("returns an empty list for an empty batch", async () => {
    await expect(extractManyWithSummarize([])).resolves.toEqual([]);
    expect(h.fetchLinkContent).not.toHaveBeenCalled();
  });
});

describe("extractWithSummarize — binary payloads", () => {
  it("translates an asset-like rejection into NotExtractableError", async () => {
    h.fetchLinkContent.mockRejectedValue(
      new AssetLikeHtmlFetchError("content-type", "application/pdf"),
    );

    const error = await extractWithSummarize(
      "https://example.com/paper.pdf",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotExtractableError);
    expect((error as NotExtractableError).reason).toBe("content-type");
    expect((error as NotExtractableError).url).toBe(
      "https://example.com/paper.pdf",
    );
  });

  it("preserves the reason for a signature sniffed payload", async () => {
    h.fetchLinkContent.mockRejectedValue(
      new AssetLikeHtmlFetchError("binary-payload"),
    );

    const error = await extractWithSummarize(
      "https://example.com/dl?id=9",
    ).catch((caught: unknown) => caught);

    expect((error as NotExtractableError).reason).toBe("binary-payload");
  });

  it("does not swallow unrelated failures", async () => {
    const failure = new TypeError("fetch failed");
    h.fetchLinkContent.mockRejectedValue(failure);

    await expect(extractWithSummarize("https://x.com")).rejects.toBe(failure);
  });

  it("counts a binary payload as a routing signal, not a warning", async () => {
    h.fetchLinkContent.mockRejectedValue(
      new AssetLikeHtmlFetchError("content-type", "image/png"),
    );

    const outcomes = await extractManyWithSummarize(["https://x.com/a.png"]);

    expect(outcomes[0]).toMatchObject({
      url: "https://x.com/a.png",
      ok: false,
    });
    expect((outcomes[0] as { error: unknown }).error).toBeInstanceOf(
      NotExtractableError,
    );
    // Binary is expected traffic; only real faults deserve a warning.
    expect(libLog.warn).not.toHaveBeenCalled();
    expect(libLog.debug).toHaveBeenCalled();
  });
});

describe("extractWithSummarize — deadline", () => {
  it("waits as long as it likes when no deadline is configured", async () => {
    h.fetchLinkContent.mockResolvedValue(extracted());

    const result = await extractWithSummarize("https://example.com");

    expect(result.characters).toBe(500);
  });

  it("returns the body when it settles inside the deadline", async () => {
    h.fetchLinkContent.mockResolvedValue(extracted());

    const result = await extractWithSummarize("https://example.com", {
      deadlineMs: 5_000,
    });

    expect(result.characters).toBe(500);
  });

  it("throws ExtractionDeadlineError when the extraction overruns", async () => {
    // Never resolves: the point is that we stop waiting for it.
    h.fetchLinkContent.mockReturnValue(new Promise(() => undefined));

    await expect(
      extractWithSummarize("https://example.com/slow", {
        deadlineMs: 10,
      }),
    ).rejects.toBeInstanceOf(ExtractionDeadlineError);
  });

  it("reports the url and the budget that was blown", async () => {
    h.fetchLinkContent.mockReturnValue(new Promise(() => undefined));

    await expect(
      extractWithSummarize("https://example.com/slow", {
        deadlineMs: 10,
      }),
    ).rejects.toMatchObject({
      url: "https://example.com/slow",
      deadlineMs: 10,
    });
  });

  it("does not report a deadline as a non-extractable payload", async () => {
    // The distinction drives routing: a timeout must reach the normal browser
    // config, not the PDF strategy.
    h.fetchLinkContent.mockReturnValue(new Promise(() => undefined));

    const error = await extractWithSummarize("https://example.com", {
      deadlineMs: 10,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ExtractionDeadlineError);
    expect(error).not.toBeInstanceOf(NotExtractableError);
  });

  it("survives the abandoned promise rejecting after the deadline", async () => {
    let rejectLate: (reason: Error) => void = () => undefined;
    h.fetchLinkContent.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      }),
    );

    await expect(
      extractWithSummarize("https://example.com", { deadlineMs: 10 }),
    ).rejects.toBeInstanceOf(ExtractionDeadlineError);

    // The extraction keeps running after we stop waiting. If its later
    // rejection were unhandled it would take the worker down.
    rejectLate(new Error("late failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("still translates a binary payload when a deadline is set", async () => {
    h.fetchLinkContent.mockRejectedValue(
      new AssetLikeHtmlFetchError("content-type", "application/pdf"),
    );

    await expect(
      extractWithSummarize("https://example.com/x.pdf", {
        deadlineMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(NotExtractableError);
  });

  it("passes the deadline on through the batch helper", async () => {
    h.fetchLinkContent.mockReturnValue(new Promise(() => undefined));

    const outcomes = await extractManyWithSummarize(["https://example.com/a"], {
      deadlineMs: 10,
    });

    expect(outcomes[0]).toMatchObject({ ok: false });
    expect(!outcomes[0]?.ok && outcomes[0].error).toBeInstanceOf(
      ExtractionDeadlineError,
    );
  });
});
