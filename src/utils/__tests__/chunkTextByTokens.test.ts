import { describe, expect, it } from "vitest";
import type { PreTrainedTokenizer } from "@huggingface/transformers";

import { chunkByTokens, countTokens } from "~/utils/chunkTextByTokens.js";
import { estimateTextTokens } from "~/utils/messageTokens.js";

/**
 * A tiny stand-in for a HuggingFace tokenizer.
 *
 * The real models are a ~100 MB download, and the thing under test is the
 * chunking arithmetic rather than the model, so this tokenizes on whitespace
 * and reports token-for-token. That keeps the token-counting branches live
 * without turning a unit test into a network test.
 */
interface FakeTokenizer {
  encode(text: string, options?: { add_special_tokens?: boolean }): number[];
  decode(tokens: number[], options?: { skip_special_tokens?: boolean }): string;
}

function asTokenizer(fake: FakeTokenizer): PreTrainedTokenizer {
  return fake as unknown as PreTrainedTokenizer;
}

function wordTokenizer(): FakeTokenizer & { encoded: string[] } {
  const encoded: string[] = [];
  return {
    encoded,
    encode: (text) => {
      encoded.push(text);
      return text
        .split(/\s+/)
        .filter((part) => part !== "")
        .map((part) => part.length);
    },
    decode: (tokens) => tokens.map((t) => "x".repeat(t)).join(" "),
  };
}

describe("countTokens", () => {
  it("estimates from the character count when no tokenizer is given", () => {
    expect(countTokens("abcdefgh", undefined, 4)).toBe(2);
    expect(estimateTextTokens("abcdefgh", 4)).toBe(2);
  });

  it("rounds an estimate up, so a partial token still counts", () => {
    // Five characters at four per token is 1.25, which is two tokens' worth of
    // budget: undercounting here is how a chunk silently overflows.
    expect(countTokens("abcde", undefined, 4)).toBe(2);
  });

  it("uses the tokenizer when one is supplied", () => {
    const tokenizer = wordTokenizer();
    expect(countTokens("one two three", asTokenizer(tokenizer))).toBe(3);
    expect(tokenizer.encoded).toEqual(["one two three"]);
  });

  it("returns zero for empty text", () => {
    expect(countTokens("", undefined, 4)).toBe(0);
  });
});

describe("chunkByTokens", () => {
  it("returns no chunks for blank text", () => {
    expect(chunkByTokens("", 100, 10)).toEqual([]);
    expect(chunkByTokens("   \n\t ", 100, 10)).toEqual([]);
  });

  it("keeps a short text as a single chunk", () => {
    expect(chunkByTokens("hello world", 100, 10)).toEqual(["hello world"]);
  });

  it("splits on paragraph boundaries when the text is too long", () => {
    // Twelve characters per paragraph at four per token is three tokens; a cap
    // of six holds two paragraphs.
    const first = "aaaa bbbb";
    const second = "cccc dddd";
    const third = "eeee ffff";
    const chunks = chunkByTokens([first, second, third].join("\n\n"), 6, 1);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk is within budget.
    for (const chunk of chunks) {
      expect(countTokens(chunk, undefined, 4)).toBeLessThanOrEqual(6);
    }
    // Nothing was silently dropped.
    expect(chunks.join(" ").replace(/\s+/g, " ")).toContain("aaaa");
    expect(chunks.join(" ").replace(/\s+/g, " ")).toContain("ffff");
  });

  it("carries an overlap into the next chunk", () => {
    const paragraph = "a".repeat(40);
    const chunks = chunkByTokens(`${paragraph}\n\n${paragraph}`, 4, 1);
    expect(chunks.length).toBeGreaterThan(1);
    // The second chunk starts with the tail of the first, by construction.
    expect(chunks[1]?.startsWith("a")).toBe(true);
  });

  it("drops the overlap rather than exceeding the cap", () => {
    // A part that fits alone but not with the overlap must still be kept whole.
    const chunks = chunkByTokens("aaaa\n\nbbbb", 2, 1);
    for (const chunk of chunks) {
      expect(countTokens(chunk, undefined, 4)).toBeLessThanOrEqual(2);
    }
    expect(chunks).toContain("bbbb");
  });

  it("splits an oversized single paragraph at line boundaries", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `line${String(i)}`).join(
      "\n",
    );
    const chunks = chunkByTokens(lines, 3, 1);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toContain("line0");
    expect(chunks.join("\n")).toContain("line7");
  });

  it("skips blank lines inside an oversized paragraph", () => {
    const text = `aaaa\n\n\n\nbbbb\n\ncccc`;
    const chunks = chunkByTokens(text, 3, 1);
    expect(chunks.join("")).toContain("cccc");
    for (const chunk of chunks) expect(chunk).not.toBe("");
  });

  it("hard-splits a single line longer than the whole budget", () => {
    const line = "x".repeat(60);
    const chunks = chunkByTokens(line, 4, 1);

    // 4 tokens at 4 chars each is a 16-character window, advancing by the
    // `maxTokens - overlap` step of 12 characters: starts 0, 12, 24, 36, 48.
    // The last window is clipped by the end of the line.
    expect(chunks.map((chunk) => chunk.length)).toEqual([16, 16, 16, 16, 12]);
    // The windows overlap rather than abutting, so the overlap repeats.
    expect(chunks.every((chunk) => /^x+$/.test(chunk))).toBe(true);
    expect(chunks.join("")).toHaveLength(76);
  });

  it("refuses an overlap that leaves no room to advance", () => {
    const line = "x".repeat(60);
    expect(() => chunkByTokens(line, 4, 4)).toThrow(
      "overlapTokens must be smaller than maxTokens",
    );
  });

  it("does not duplicate when the overlap is zero", () => {
    const line = "y".repeat(40);
    const chunks = chunkByTokens(line, 4, 0);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(line);
  });

  it("splits by tokens when a tokenizer is supplied", () => {
    const tokenizer = asTokenizer(wordTokenizer());
    const words = Array.from({ length: 10 }, () => "xxxx").join(" ");
    const chunks = chunkByTokens(words, 4, 1, tokenizer);

    expect(chunks.length).toBeGreaterThan(1);
    // The tokenizer branch decodes slices rather than slicing characters.
    for (const chunk of chunks) expect(chunk).not.toBe("");
  });

  it("keeps the whole value as overlap when it is shorter than the window", () => {
    const tokenizer = asTokenizer(wordTokenizer());
    const chunks = chunkByTokens("aa\n\nbb", 100, 50, tokenizer);
    // Everything fits, so the overlap logic is never consulted for a split.
    expect(chunks).toEqual(["aa\n\nbb"]);
  });

  it("never emits an empty chunk", () => {
    const chunks = chunkByTokens("a\n\n\n\nb\n\n\n\nc", 2, 0);
    for (const chunk of chunks) expect(chunk.trim()).toBe(chunk);
    expect(chunks.every((chunk) => chunk !== "")).toBe(true);
  });

  it("hard-splits a single line with the tokenizer, dropping empty decodes", () => {
    // A tokenizer decodes some slices to nothing (special tokens, partial
    // multi-byte sequences). The `if (decoded)` guard is the only thing standing
    // between a blank slice and a chunk the caller would send upstream, so this
    // fake returns "" for every odd-length slice.
    const tokenizer = asTokenizer({
      encode: (text: string) => text.split("").map(() => 1),
      decode: (tokens: number[]) =>
        tokens.length % 2 === 0 ? "w".repeat(tokens.length) : "",
    });

    // maxTokens 4, overlap 1 -> step 3, so windows start at 0,3,…,21 over 24
    // tokens. The tail slice is 3 tokens long, decodes to "", and is skipped.
    const chunks = chunkByTokens("z".repeat(24), 4, 1, tokenizer);

    expect(chunks).toHaveLength(7);
    expect(chunks.every((chunk) => chunk !== "")).toBe(true);
    expect(chunks.every((chunk) => chunk === "wwww")).toBe(true);
  });

  it("keeps the overlap as the whole value when the tokenizer window swallows it", () => {
    // `getOverlap` short-circuits when the overlap window is at least as long as
    // the chunk, which is the "carry everything forward" branch.
    const tokenizer = asTokenizer(wordTokenizer());
    const chunks = chunkByTokens("aa bb\n\ncc dd", 3, 3, tokenizer);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk).not.toBe("");
  });

  it("does not repeat the overlap on the final chunk", () => {
    const chunks = chunkByTokens("aa\n\nbb\n\ncc", 1, 1);
    // The last push passes `keepOverlap = false`, so the final chunk holds only
    // its own text and nothing trails it.
    expect(chunks.at(-1)).toBe("cc");
  });

  it("returns nothing for a text made entirely of paragraph separators", () => {
    // Every split part trims to "", so `addPart` is never called and the loop
    // ends without a chunk.
    expect(chunkByTokens("\n\n\n\n\n\n", 4, 1)).toEqual([]);
  });

  it("carries a character overlap when no tokenizer is supplied", () => {
    // `estimateTextTokens` is `ceil(length / 4)`, so a 40-char paragraph is 10
    // tokens. Two of those need 20, over a budget of 15, so the first is pushed
    // and its character overlap seeds the next chunk. The overlap is
    // `overlapTokens * 4` characters taken from the end.
    const first = "a".repeat(40);
    const second = "b".repeat(40);

    const chunks = chunkByTokens(`${first}\n\n${second}`, 15, 2);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(first);
    // The second chunk starts with the last 8 characters of the first.
    expect(chunks[1]).toBe(`${"a".repeat(8)}\n\n${second}`);
  });

  it("keeps the whole chunk as overlap when it is shorter than the window", () => {
    // 4 tokens of `first` plus the 4-token `second` would be 8, over a budget of
    // 7, so the first chunk is pushed. Its overlap window is 4 tokens but the
    // chunk is only 2 tokens long, so `getOverlap` keeps the whole chunk rather
    // than a suffix — that is the `tokens.length <= overlapTokens` branch.
    const first = "c".repeat(8);
    const second = "d".repeat(20);

    const chunks = chunkByTokens(`${first}\n\n${second}`, 7, 4);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(first);
    // `overlap (2 tokens) + second (5 tokens)` is still over budget, so the
    // overlap is dropped and the second chunk is the part alone.
    expect(chunks[1]).toBe(second);
  });

  it("drops the overlap when the next part would not fit beside it", () => {
    // `withOverlap` exceeds the budget while `part` alone fits, which is the
    // branch that discards the overlap instead of exceeding the cap.
    const first = "e".repeat(20);
    const second = "f".repeat(36);

    const chunks = chunkByTokens(`${first}\n\n${second}`, 10, 4);

    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe(second);
  });
});
