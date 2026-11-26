import { describe, expect, it } from "vitest";

import {
  EMPTY_COMPACTION_STATE,
  compactHistory,
  historyToMessages,
} from "~/chat/compactChat.js";
import type { Compaction, HistoryMessage } from "~/types/Compaction.js";

/**
 * History compaction: turning stored messages into provider messages, and
 * folding the older half of a conversation into a carried-over summary.
 *
 * A compaction bug does not throw — it silently drops the message the user is
 * waiting on — so each case asserts exactly which message survives and where
 * the watermark lands.
 */

function history(
  entries: {
    id: number;
    role: "user" | "assistant";
    message: string;
    trace?: unknown;
  }[],
): HistoryMessage[] {
  return entries.map((entry) => ({
    id: entry.id,
    role: entry.role,
    message: entry.message,
    trace: (entry.trace ?? null) as HistoryMessage["trace"],
  }));
}

/**
 * A `Compaction` config with the model knobs filled in.
 *
 * `temperature` and `maxTokens` are real settings the caller supplies for the
 * summariser; `compactHistory` never reads them, so any value works. Only the
 * three threshold fields change behaviour, which is what each test varies.
 */
function compaction(
  overrides: Pick<Compaction, "keepRecentMessages" | "tokenThreshold"> &
    Partial<Pick<Compaction, "reserveTokens">>,
): Compaction {
  return { temperature: 0, maxTokens: 1_000, ...overrides };
}

describe("historyToMessages", () => {
  it("passes a user message through unchanged", () => {
    const [message] = historyToMessages({
      id: 1,
      role: "user",
      message: "hello",
      trace: null,
    });

    expect(message).toEqual({ role: "user", content: "hello" });
  });

  it("passes an assistant message with no steps through unchanged", () => {
    const [message] = historyToMessages({
      id: 2,
      role: "assistant",
      message: "an answer",
      trace: null,
    });

    expect(message).toEqual({ role: "assistant", content: "an answer" });
  });

  it("expands an assistant message with tool steps into a tool call plus results", () => {
    const messages = historyToMessages({
      id: 3,
      role: "assistant",
      message: "the final answer",
      trace: {
        reasoning: [],
        steps: [
          {
            id: "call-1",
            name: "search",
            args: { q: "hi" },
            result: "search result",
          },
        ],
      } as never,
    });

    expect(messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "search", arguments: '{"q":"hi"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "search result" },
      { role: "assistant", content: "the final answer" },
    ]);
  });

  it("serialises missing tool arguments as an empty object", () => {
    const messages = historyToMessages({
      id: 4,
      role: "assistant",
      message: "answer",
      trace: {
        reasoning: [],
        steps: [{ id: "c", name: "tool", args: undefined, result: "r" }],
      } as never,
    });

    expect(
      (messages[0] as { tool_calls: { function: { arguments: string } }[] })
        .tool_calls[0].function.arguments,
    ).toBe("{}");
  });
});

describe("compactHistory", () => {
  it("returns the whole pending history when it fits the budget", async () => {
    const pending = history([
      { id: 1, role: "user", message: "hi" },
      { id: 2, role: "assistant", message: "hello" },
    ]);
    const summarize = () => Promise.resolve("never called");

    const outcome = await compactHistory(
      pending,
      EMPTY_COMPACTION_STATE,
      compaction({ keepRecentMessages: 1, tokenThreshold: 10_000 }),
      summarize,
    );

    expect(outcome.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(outcome.update).toEqual({
      summary: null,
      throughMessageId: null,
      changed: false,
    });
    expect(outcome.estimatedTokens).toBeGreaterThan(0);
  });

  it("compacts the older messages and keeps the recent tail", async () => {
    const pending = history([
      { id: 1, role: "user", message: "first question" },
      { id: 2, role: "assistant", message: "first answer" },
      { id: 3, role: "user", message: "second question" },
      { id: 4, role: "assistant", message: "second answer" },
    ]);
    let prompt = "";

    const outcome = await compactHistory(
      pending,
      EMPTY_COMPACTION_STATE,
      compaction({ keepRecentMessages: 2, tokenThreshold: 5 }),
      (value) => {
        prompt = value;
        return Promise.resolve("a merged summary");
      },
    );

    expect(outcome.update).toEqual({
      summary: "a merged summary",
      throughMessageId: 2,
      changed: true,
    });
    expect(outcome.messages).toEqual([
      {
        role: "system",
        content:
          "[System Note: Earlier conversation summary: a merged summary]",
      },
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" },
    ]);
    // The prompt carries the transcript of only the compacted messages.
    expect(prompt).toContain("user: first question");
    expect(prompt).toContain("assistant: first answer");
    expect(prompt).not.toContain("second question");
  });

  it("carries the existing summary into the merge prompt", async () => {
    const pending = history([
      { id: 1, role: "user", message: "old" },
      { id: 2, role: "user", message: "new" },
    ]);
    let prompt = "";

    await compactHistory(
      pending,
      { summary: "the earlier summary", throughMessageId: 0 },
      compaction({ keepRecentMessages: 1, tokenThreshold: 1 }),
      (value) => {
        prompt = value;
        return Promise.resolve("merged");
      },
    );

    expect(prompt).toContain("Existing summary of the conversation so far:");
    expect(prompt).toContain("the earlier summary");
  });

  it("ignores messages at or below the watermark", async () => {
    const pending = history([
      { id: 1, role: "user", message: "already summarised" },
      { id: 2, role: "user", message: "fresh" },
    ]);
    let prompt = "";

    const outcome = await compactHistory(
      pending,
      { summary: "old summary", throughMessageId: 1 },
      compaction({ keepRecentMessages: 0, tokenThreshold: 1 }),
      (value) => {
        prompt = value;
        return Promise.resolve("new summary");
      },
    );

    expect(prompt).toContain("fresh");
    expect(prompt).not.toContain("already summarised");
    expect(outcome.update.throughMessageId).toBe(2);
  });

  it("does nothing when the budget is exceeded but there is nothing to compact", async () => {
    const pending = history([{ id: 1, role: "user", message: "only one" }]);
    const summarize = () => Promise.resolve("never called");

    const outcome = await compactHistory(
      pending,
      EMPTY_COMPACTION_STATE,
      compaction({ keepRecentMessages: 5, tokenThreshold: 1 }),
      summarize,
    );

    expect(outcome.update.changed).toBe(false);
    expect(outcome.messages).toEqual([{ role: "user", content: "only one" }]);
  });

  it("subtracts the reserved tokens from the budget", async () => {
    const pending = history([
      { id: 1, role: "user", message: "a".repeat(400) },
      { id: 2, role: "user", message: "short" },
    ]);
    let compactions = 0;
    const summarize = (): Promise<string> => {
      compactions += 1;
      return Promise.resolve("summary");
    };

    // A budget generous enough to skip compaction outright.
    const generous = await compactHistory(
      pending,
      EMPTY_COMPACTION_STATE,
      compaction({ keepRecentMessages: 1, tokenThreshold: 1_000 }),
      summarize,
    );
    expect(generous.update.changed).toBe(false);
    expect(compactions).toBe(0);

    // Reserving most of that budget drops the usable window below the estimate,
    // so the same history now has to compact.
    const reserved = await compactHistory(
      pending,
      EMPTY_COMPACTION_STATE,
      compaction({
        keepRecentMessages: 1,
        tokenThreshold: 1_000,
        reserveTokens: 990,
      }),
      summarize,
    );
    expect(reserved.update.changed).toBe(true);
    expect(compactions).toBe(1);
  });

  it("treats a fractional keepRecentMessages as a floor", async () => {
    const pending = history([
      { id: 1, role: "user", message: "a".repeat(200) },
      { id: 2, role: "user", message: "b".repeat(200) },
      { id: 3, role: "user", message: "c" },
    ]);

    const outcome = await compactHistory(
      pending,
      EMPTY_COMPACTION_STATE,
      compaction({ keepRecentMessages: 1.9, tokenThreshold: 5 }),
      () => Promise.resolve("summary"),
    );

    // floor(1.9) = 1, so only the last message survives verbatim.
    expect(outcome.messages.at(-1)).toEqual({ role: "user", content: "c" });
  });

  it("keeps no messages when keepRecentMessages is zero", async () => {
    const pending = history([
      { id: 1, role: "user", message: "a".repeat(200) },
      { id: 2, role: "user", message: "b".repeat(200) },
    ]);

    const outcome = await compactHistory(
      pending,
      EMPTY_COMPACTION_STATE,
      compaction({ keepRecentMessages: 0, tokenThreshold: 5 }),
      () => Promise.resolve("summary"),
    );

    expect(outcome.messages).toEqual([
      {
        role: "system",
        content: "[System Note: Earlier conversation summary: summary]",
      },
    ]);
  });

  it("never compacts a negative keep count into a negative slice", async () => {
    const pending = history([
      { id: 1, role: "user", message: "a".repeat(200) },
      { id: 2, role: "user", message: "b".repeat(200) },
    ]);

    const outcome = await compactHistory(
      pending,
      EMPTY_COMPACTION_STATE,
      compaction({ keepRecentMessages: -3, tokenThreshold: 5 }),
      () => Promise.resolve("summary"),
    );

    expect(outcome.update.throughMessageId).toBe(2);
  });

  it("expands tool steps of the kept messages into provider messages", async () => {
    const pending = history([
      { id: 1, role: "user", message: "a".repeat(400) },
      {
        id: 2,
        role: "assistant",
        message: "the answer",
        trace: {
          reasoning: [],
          steps: [{ id: "c1", name: "tool", args: {}, result: "tool output" }],
        },
      },
    ]);

    const outcome = await compactHistory(
      pending,
      EMPTY_COMPACTION_STATE,
      compaction({ keepRecentMessages: 1, tokenThreshold: 5 }),
      () => Promise.resolve("summary"),
    );

    expect(outcome.messages).toEqual([
      {
        role: "system",
        content: "[System Note: Earlier conversation summary: summary]",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "tool", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "tool output" },
      { role: "assistant", content: "the answer" },
    ]);
  });
});
