import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type OpenAI from "openai";
import type { Kysely } from "kysely";

import type { Database } from "~/db/schema.js";
import type { SseFrame } from "~/types/Chat.js";
import type { ToolLoopClient, ToolExecutionContext } from "~~/src/types/ToolExecutionTypes.js";
import { cacheSet } from "~/config/config.js";
import { fileKey, readGeneratedFile } from "~/utils/generatedFile.js";
import { framesToStream } from "~/utils/framesToStream.js";
import { SSE_HEARTBEAT } from "~/chat/sse.js";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";
import { libLog, libLogger } from "~~/test/test-utils/logger";
import {
  chatCompletion,
  createFakeLlm,
  messageContent,
} from "~~/test/test-utils/llm";
import {
  embeddingFake,
  installEmbeddingFake,
  offlineClient,
} from "~~/test/test-utils/streamLlm";

/**
 * The remaining seams: generated-file retrieval, the SSE bridge, the compaction
 * wrapper used by the agent, and the two side-effecting tool handlers.
 *
 * The theme is failure handling. Every one of these has a "the thing went away"
 * branch — an expired file, a disconnected reader, an API error, a bad currency
 * code — and in each case the contract is to report it rather than throw into
 * the turn.
 */

const DIMENSIONS = 8;

interface Harness {
  env: LoadedConfig;
  db: Kysely<Database>;
}

let harness: Harness;

async function boot(): Promise<Harness> {
  const client: OpenAI = offlineClient();
  installEmbeddingFake(client, embeddingFake(DIMENSIONS));
  const env = await loadConfig({
    logger: libLogger,
    dimensions: DIMENSIONS,
    overrides: {
      embeddingConfig: {
        client,
        dimensions: DIMENSIONS,
        matchingModel: "test-matching",
        retrievalModel: "test-retrieval",
      },
    },
  });
  return { env, db: env.mod.getDb() };
}

beforeAll(async () => {
  harness = await boot();
});

/** The context the tool handlers receive; these handlers ignore it. */
const ctx: ToolExecutionContext = {
  toolCallId: "call-1",
  callIndex: 1,
  callTotal: 1,
};

beforeEach(async () => {
  await harness.env.truncate();
});

describe("readGeneratedFile", () => {
  it("returns the decoded bytes and the download headers", async () => {
    const payload = Buffer.from("hello file", "utf-8");
    await cacheSet(
      fileKey("abc"),
      JSON.stringify({
        base64Data: payload.toString("base64"),
        mimeType: "text/plain",
        filename: "greeting.txt",
      }),
      60_000,
    );

    const outcome = await readGeneratedFile("abc");

    expect(outcome).toMatchObject({
      ok: true,
      file: {
        filename: "greeting.txt",
        mimeType: "text/plain",
        headers: {
          "Content-Type": "text/plain",
          "Content-Disposition": 'attachment; filename="greeting.txt"',
          // Content-Length is the decoded size, never the base64 length.
          "Content-Length": String(payload.length),
        },
      },
    });
    if (outcome.ok) {
      expect(outcome.file.buffer.equals(payload)).toBe(true);
    }
  });

  it("falls back to generic defaults when the envelope omits them", async () => {
    await cacheSet(
      fileKey("bare"),
      JSON.stringify({ base64Data: Buffer.from("x").toString("base64") }),
      60_000,
    );

    const outcome = await readGeneratedFile("bare");

    expect(outcome).toMatchObject({
      ok: true,
      file: {
        filename: "download",
        mimeType: "application/octet-stream",
        headers: {
          "Content-Disposition": 'attachment; filename="download"',
        },
      },
    });
  });

  it("reports not_found for an expired or unknown id", async () => {
    const outcome = await readGeneratedFile("missing");

    expect(outcome).toEqual({
      ok: false,
      reason: "not_found",
      message: "File not found or expired",
    });
    expect(libLog.info).toHaveBeenCalledWith(
      { fileId: "missing" },
      "[files] File not found or expired",
    );
  });

  it("reports corrupt for an envelope that is not JSON", async () => {
    await cacheSet(fileKey("bad"), "not json at all", 60_000);

    const outcome = await readGeneratedFile("bad");

    expect(outcome).toEqual({
      ok: false,
      reason: "corrupt",
      message: "Failed to process file data",
    });
    expect(libLog.error).toHaveBeenCalledWith(
      { err: expect.anything(), fileId: "bad" },
      "[files] Failed to process file data",
    );
  });

  it("namespaces the key so it cannot collide with another cache entry", () => {
    expect(fileKey("abc")).toBe("file:abc");
  });
});

describe("framesToStream", () => {
  function frame(type: string, data: unknown): SseFrame {
    return { type, data };
  }

  it("encodes every frame into the stream body", async () => {
    async function* frames(): AsyncGenerator<SseFrame> {
      yield frame("text", { text: "one" });
      yield frame("text", { text: "two" });
    }

    const stream = framesToStream(frames(), { heartbeatMs: 60_000 });
    const body = await new Response(stream).text();

    expect(body).toContain("one");
    expect(body).toContain("two");
    // Two events, each terminated by a blank line.
    expect(body.split("\n\n").filter((part) => part.trim() !== "")).toHaveLength(2);
  });

  it("emits a heartbeat frame while the producer is idle", async () => {
    const release: (() => void)[] = [];
    async function* frames(): AsyncGenerator<SseFrame> {
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      yield frame("text", { text: "late" });
    }

    const stream = framesToStream(frames(), { heartbeatMs: 10 });
    const reader = stream.getReader();
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe(SSE_HEARTBEAT);
    release.forEach((resolve) => {
      resolve();
    });
    await reader.cancel();
  });

  it("calls onCancel when the reader disconnects", async () => {
    const onCancel = vi.fn();
    async function* frames(): AsyncGenerator<SseFrame> {
      yield frame("text", { text: "one" });
      await new Promise<void>(() => {
        // Never resolves: the generator has to be unwound from outside.
      });
    }

    const stream = framesToStream(frames(), { heartbeatMs: 60_000, onCancel });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("closes the stream when the producer throws", async () => {
    async function* frames(): AsyncGenerator<SseFrame> {
      yield frame("text", { text: "before" });
      throw new Error("producer exploded");
    }

    const stream = framesToStream(frames(), { heartbeatMs: 60_000 });
    const body = await new Response(stream).text();

    // The failure is reported by the turn's own error frame; the bridge just
    // closes cleanly instead of propagating.
    expect(body).toContain("before");
  });
});

describe("buildHistoryMessages", () => {
  it("passes history straight through when compaction is not configured", async () => {
    const { buildHistoryMessages } = await import("~/agents/prompt.js");
    const fake = createFakeLlm();

    const messages = await buildHistoryMessages({
      history: [
        { id: 1, role: "user", message: "hi", trace: null },
        { id: 2, role: "assistant", message: "hello", trace: null },
      ],
      state: { summary: null, throughMessageId: null },
      compaction: undefined,
      conversationId: 1,
      client: fake.client as unknown as ToolLoopClient,
      model: { model: "test-model" },
    });

    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    // No summariser call was made.
    expect(fake.calls).toEqual([]);
  });

  it("summarises through the client and persists the new watermark", async () => {
    const { buildHistoryMessages } = await import("~/agents/prompt.js");
    const fake = createFakeLlm(chatCompletion("the merged summary"));
    const conversationId = await harness.db
      .insertInto("conversations")
      .values({ user_id: "u-1" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const messages = await buildHistoryMessages({
      history: [
        { id: 1, role: "user", message: "a".repeat(400), trace: null },
        { id: 2, role: "assistant", message: "b".repeat(400), trace: null },
        { id: 3, role: "user", message: "recent", trace: null },
      ],
      state: { summary: null, throughMessageId: null },
      compaction: {
        keepRecentMessages: 1,
        tokenThreshold: 10,
        temperature: 0.2,
        maxTokens: 128,
      },
      conversationId: conversationId.id,
      client: fake.client as unknown as ToolLoopClient,
      model: { model: "test-model" },
    });

    expect(messageContent(fake.calls[0], "user")).toContain(
      "User: a".replace("User", "user"),
    );
    expect(messages.at(-1)).toEqual({ role: "user", content: "recent" });

    const row = await harness.db
      .selectFrom("conversations")
      .select(["compacted_summary", "compacted_through_message_id"])
      .where("id", "=", conversationId.id)
      .executeTakeFirstOrThrow();
    expect(row.compacted_summary).toBe("the merged summary");
    expect(row.compacted_through_message_id).toBe(2);
  });

  it("does not write a watermark when there is no conversation id", async () => {
    const { buildHistoryMessages } = await import("~/agents/prompt.js");
    const fake = createFakeLlm(chatCompletion("a summary"));

    await buildHistoryMessages({
      history: [{ id: 1, role: "user", message: "a".repeat(400), trace: null }],
      state: { summary: null, throughMessageId: null },
      compaction: {
        keepRecentMessages: 0,
        tokenThreshold: 1,
        temperature: 0,
        maxTokens: 128,
      },
      conversationId: undefined,
      client: fake.client as unknown as ToolLoopClient,
      model: { model: "test-model" },
    });

    expect(
      await harness.db.selectFrom("conversations").selectAll().execute(),
    ).toEqual([]);
  });

  it("prepends no system note when the summariser returns no content", async () => {
    const { buildHistoryMessages } = await import("~/agents/prompt.js");
    // A completion whose assistant content is null: the summariser falls back to
    // an empty string, which `summaryMessage` treats as "nothing to report".
    const fake = createFakeLlm({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "test-model",
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: null } },
      ],
    });

    const messages = await buildHistoryMessages({
      history: [
        { id: 1, role: "user", message: "a".repeat(400), trace: null },
        { id: 2, role: "user", message: "b".repeat(400), trace: null },
      ],
      state: { summary: null, throughMessageId: null },
      compaction: {
        keepRecentMessages: 0,
        tokenThreshold: 1,
        temperature: 0,
        maxTokens: 128,
      },
      conversationId: undefined,
      client: fake.client as unknown as ToolLoopClient,
      model: { model: "test-model" },
    });

    // No summary came back, so no system note is prepended.
    expect(messages).toEqual([]);
  });
});

describe("createAgent", () => {
  it("delegates construction to buildAgent", async () => {
    const mod = await import("~/agents/createAgent.js");
    const { buildAgent } = await import("~/agents/agent.js");

    // The wrapper exists so the public surface is a named factory; assert it
    // rejects the same misconfiguration buildAgent does rather than silently
    // constructing a broken agent.
    await expect(
      mod.createAgent({
        model: { model: "test-model" },
        systemInstructions: "be brief",
        conversation: { persist: false },
        runs: { kind: "chat" },
      }),
    ).rejects.toThrow(
      "AgentConfig: `runs` requires `conversation` with `persist: true`.",
    );
    expect(typeof buildAgent).toBe("function");
  });
});

describe("currenciesConvertor tool", () => {
  it("reports a validation failure for a missing currency code", async () => {
    const { currenciesConvertor } = await import(
      "~~/src/tools/common-tools-handlers/currencyConverter.js"
    );

    const result = await currenciesConvertor()({ amount: 10, from: "USD" }, ctx);

    expect(typeof result).toBe("string");
    expect(JSON.parse(result as string)).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("reports a conversion failure for an unknown currency code", async () => {
    const { currenciesConvertor } = await import(
      "~~/src/tools/common-tools-handlers/currencyConverter.js"
    );

    const result = await currenciesConvertor()({
      amount: 10,
      from: "ZZZ",
      to: "YYY",
    }, ctx);

    expect(typeof result).toBe("string");
    expect(JSON.parse(result as string)).toMatchObject({
      error: {
        code: "CONVERSION_FAILED",
        message:
          "Unable to convert currencies. Check if the currency codes are valid.",
      },
    });
    expect(libLog.error).toHaveBeenCalledWith(
      { err: expect.anything() },
      "Currency conversion failed.",
    );
  });
});
