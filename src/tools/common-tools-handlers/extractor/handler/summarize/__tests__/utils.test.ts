import { describe, expect, it } from "vitest";

import type { ExtractedLinkContent } from "@steipete/summarize-core/content";
import {
  resolveLength,
  trimmedOr,
  trimmedOrNull,
  usableContent,
} from "../utils.js";

function extracted(
  overrides: Partial<ExtractedLinkContent> = {},
): ExtractedLinkContent {
  return {
    url: "https://example.com",
    title: "Title",
    description: null,
    siteName: null,
    content: "",
    truncated: false,
    totalCharacters: 0,
    wordCount: 0,
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

describe("usableContent", () => {
  it("uses the page body when it is longer than the transcript", () => {
    const result = usableContent(
      extracted({ content: "page body", transcriptTimedText: "short" }),
    );

    expect(result).toEqual({ text: "page body", fromTranscript: false });
  });

  it("prefers the transcript when it is longer", () => {
    const result = usableContent(
      extracted({
        content: "page",
        transcriptTimedText: "a much longer transcript body",
      }),
    );

    expect(result).toEqual({
      text: "a much longer transcript body",
      fromTranscript: true,
    });
  });

  it("treats a null transcript as absent", () => {
    const result = usableContent(
      extracted({ content: "page body", transcriptTimedText: null }),
    );

    expect(result).toEqual({ text: "page body", fromTranscript: false });
  });

  it("reports a transcript source even when the timed text is empty", () => {
    // The library can resolve a transcript without shipping timed text: the
    // words end up in `content`, and `transcriptSource` is the only signal that
    // the body came from media rather than the page.
    const result = usableContent(
      extracted({
        content: "transcribed body",
        transcriptTimedText: null,
        transcriptSource: "yt-dlp",
      }),
    );

    expect(result).toEqual({ text: "transcribed body", fromTranscript: true });
  });

  it("ignores a transcript source when the page body is empty too", () => {
    // Nothing was extracted, so there is no transcript to attribute.
    const result = usableContent(
      extracted({
        content: "",
        transcriptTimedText: "",
        transcriptSource: "yt-dlp",
      }),
    );

    expect(result).toEqual({ text: "", fromTranscript: false });
  });

  it("does not attribute a page body to a transcript when timed text exists", () => {
    // A transcript that lost on length still means the page body is the page.
    const result = usableContent(
      extracted({
        content: "a longer page body",
        transcriptTimedText: "short",
        transcriptSource: "yt-dlp",
      }),
    );

    expect(result).toEqual({
      text: "a longer page body",
      fromTranscript: false,
    });
  });

  it("trims whitespace before comparing lengths", () => {
    // A whitespace-only transcript must not win on raw length.
    const result = usableContent(
      extracted({ content: "page", transcriptTimedText: "     \n\t  " }),
    );

    expect(result).toEqual({ text: "page", fromTranscript: false });
  });

  it("returns an empty body when both sources are empty", () => {
    expect(usableContent(extracted())).toEqual({
      text: "",
      fromTranscript: false,
    });
  });

  it("keeps a transcript that ties the page body in length", () => {
    // Strictly-greater means a tie stays with the page, which is the safer
    // default: the page is the primary source, the transcript the fallback.
    const result = usableContent(
      extracted({ content: "aaaa", transcriptTimedText: "bbbb" }),
    );

    expect(result.fromTranscript).toBe(false);
  });
});

describe("trimmedOr", () => {
  it("returns the trimmed value when present", () => {
    expect(trimmedOr("  hello  ", "fallback")).toBe("hello");
  });

  it("falls back on null", () => {
    expect(trimmedOr(null, "fallback")).toBe("fallback");
  });

  it("falls back on undefined", () => {
    expect(trimmedOr(undefined, "fallback")).toBe("fallback");
  });

  it("treats a whitespace-only string as absent", () => {
    // The library returns "" for a missing <title>; an empty title is not a
    // title, and `??` alone would let it through.
    expect(trimmedOr("   ", "fallback")).toBe("fallback");
  });

  it("keeps a non-string fallback intact", () => {
    expect(trimmedOr("", null)).toBeNull();
  });

  it("preserves inner whitespace", () => {
    expect(trimmedOr("  a  b  ", "")).toBe("a  b");
  });
});

describe("trimmedOrNull", () => {
  it("returns the trimmed value when present", () => {
    expect(trimmedOrNull(" desc ")).toBe("desc");
  });

  it("returns null for blank input", () => {
    expect(trimmedOrNull("  ")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(trimmedOrNull(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(trimmedOrNull(undefined)).toBeNull();
  });
});

describe("resolveLength", () => {
  it("accepts every valid length", () => {
    for (const length of ["short", "medium", "long", "xl", "xxl"] as const) {
      expect(resolveLength(length)).toBe(length);
    }
  });

  it("rejects an unknown length and falls back to the default", () => {
    expect(resolveLength("gigantic" as never)).toBe("medium");
  });

  it("falls back to the default when nothing is requested", () => {
    expect(resolveLength(undefined)).toBe("medium");
  });

  it("falls back to the default on a blank request", () => {
    // A caller passing "" means "unset", not "the empty length".
    expect(resolveLength("" as never)).toBe("medium");
  });
});
