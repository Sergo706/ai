import { describe, expect, it } from "vitest";

import type { ChatCompletionMessageParam } from "openai/resources";

import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
} from "~/utils/messageTokens.js";

/**
 * Token estimation, which is what decides whether a conversation is compacted.
 *
 * The numbers here are deliberately exact: an under-count silently overflows
 * the model's window, and an over-count compacts history that did not need it.
 */

describe("estimateTextTokens", () => {
  it("rounds up a partial token", () => {
    expect(estimateTextTokens("abcde", 4)).toBe(2);
  });

  it("returns 0 for empty text", () => {
    expect(estimateTextTokens("", 4)).toBe(0);
  });

  it("uses the caller's ratio", () => {
    expect(estimateTextTokens("a".repeat(100), 10)).toBe(10);
  });
});

describe("estimateMessageTokens", () => {
  it("adds the per-message overhead to a plain string body", () => {
    // 18 chars / 3.6 = 5 tokens, plus 4 overhead.
    expect(
      estimateMessageTokens({ role: "user", content: "abcdefghijklmnopqr" }),
    ).toBe(9);
  });

  it("handles content that is an array of text parts", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "abcd" },
        { type: "text", text: "efgh" },
      ],
    } as unknown as ChatCompletionMessageParam;

    // "abcd efgh" is 9 chars -> 3 tokens, plus 4 overhead.
    expect(estimateMessageTokens(message)).toBe(7);
  });

  it("charges a flat cost for a non-text part", () => {
    const message = {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }],
    } as unknown as ChatCompletionMessageParam;

    // One non-text part = 85 * 3 = 255 chars -> 71 tokens, plus overhead.
    expect(estimateMessageTokens(message)).toBe(75);
  });

  it("counts tool calls by name and arguments", () => {
    const message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "search", arguments: '{"q":"hi"}' },
        },
      ],
    } as unknown as ChatCompletionMessageParam;

    // "search" (6) + '{"q":"hi"}' (10) = 16 chars -> 5 tokens, plus overhead.
    expect(estimateMessageTokens(message)).toBe(9);
  });

  it("counts the name field", () => {
    const message = {
      role: "user",
      content: "abcd",
      name: "abcdefgh",
    } as unknown as ChatCompletionMessageParam;

    // 4 + 8 = 12 chars -> 4 tokens, plus overhead.
    expect(estimateMessageTokens(message)).toBe(8);
  });

  it("handles a message with no content at all", () => {
    expect(estimateMessageTokens({ role: "assistant", content: null })).toBe(4);
  });

  it("ignores a content part that is not an object", () => {
    const message = {
      role: "user",
      content: ["a bare string"],
    } as unknown as ChatCompletionMessageParam;

    // The bare string is neither text nor object, so only its own part counts
    // as non-text and the text content is empty.
    expect(estimateMessageTokens(message)).toBe(75);
  });
});

describe("estimateMessagesTokens", () => {
  it("sums the per-message estimates", () => {
    const messages = [
      { role: "user", content: "abcdefghijklmnopqr" },
      { role: "assistant", content: "abcd" },
    ] as ChatCompletionMessageParam[];

    expect(estimateMessagesTokens(messages)).toBe(
      estimateMessageTokens(messages[0]) + estimateMessageTokens(messages[1]),
    );
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(0);
  });

  it("returns 0 for an empty list", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});
