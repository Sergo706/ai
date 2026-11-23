import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Kysely } from "kysely";

import { fromJson, toJson, toVec } from "~/db/utils.js";
import type { Database } from "~/db/schema.js";
import { TraceCollector } from "~/chat/traceCollector.js";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";
import { libLog, libLogger } from "~~/test/test-utils/logger";

/**
 * The conversation-shaped models against a real database.
 *
 * Nothing here is stubbed. The point of this suite is that the SQL actually
 * runs: a mock would happily "return" rows that the real dialect can never
 * produce, and two of the bugs this library shipped were exactly of that kind —
 * a `Date` that sqlite refuses to bind and a JSON column that comes back as text
 * on one dialect and as a parsed value on the other.
 */

interface Models {
  getConversations: typeof import("../getConversations.js").getConversations;
  getMessages: typeof import("../getMessages.js").getMessages;
  loadConversationHistory: typeof import("../loadConversationHistory.js").loadConversationHistory;
  saveUserMessage: typeof import("../saveMessages.js").saveUserMessage;
  saveCachedExchange: typeof import("../saveMessages.js").saveCachedExchange;
  saveAssistantMessage: typeof import("../saveMessages.js").saveAssistantMessage;
  saveConversationCompaction: typeof import("../saveConversationCompaction.js").saveConversationCompaction;
}

interface Harness {
  env: LoadedConfig;
  db: Kysely<Database>;
  models: Models;
}

const DIMENSIONS = 8;

/** The messages suite reads `getConfiguration()` at import, so import lazily. */
async function boot(): Promise<Harness> {
  const env = await loadConfig({ logger: libLogger, dimensions: DIMENSIONS });
  const models: Models = {
    ...(await import("../getConversations.js")),
    ...(await import("../getMessages.js")),
    ...(await import("../loadConversationHistory.js")),
    ...(await import("../saveMessages.js")),
    ...(await import("../saveConversationCompaction.js")),
  };
  return { env, db: env.mod.getDb(), models };
}

/** An ISO-8601 instant, which is the only shape the models promise. */
function expectIsoDate(value: string): void {
  expect(new Date(value).toISOString()).toBe(value);
}

async function insertConversation(
  db: Kysely<Database>,
  args: {
    userId?: string;
    title?: string | null;
    updatedAt?: string;
  } = {},
): Promise<number> {
  const row = await db
    .insertInto("conversations")
    .values({
      user_id: args.userId ?? "u-1",
      title: args.title ?? "a conversation",
      ...(args.updatedAt === undefined ? {} : { updated_at: args.updatedAt }),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertMessage(
  db: Kysely<Database>,
  args: {
    conversationId: number;
    role: string;
    content: string;
    embedding?: number[] | null;
    toolsUsed?: string[] | null;
    trace?: unknown;
    createdAt?: string;
  },
): Promise<number> {
  const row = await db
    .insertInto("messages")
    .values({
      conversation_id: args.conversationId,
      role: args.role,
      content: args.content,
      embedding:
        args.embedding === undefined || args.embedding === null
          ? null
          : toVec(args.embedding),
      tools_used: toJson(args.toolsUsed ?? null),
      trace: toJson(args.trace ?? null),
      ...(args.createdAt === undefined ? {} : { created_at: args.createdAt }),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

let harness: Harness;

beforeAll(async () => {
  harness = await boot();
});

beforeEach(async () => {
  await harness.env.truncate();
});

describe("getConversations", () => {
  it("returns the caller's conversations newest first", async () => {
    const { db, models } = harness;
    await insertConversation(db, {
      userId: "u-1",
      title: "older",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    await insertConversation(db, {
      userId: "u-1",
      title: "newest",
      updatedAt: "2024-03-01T00:00:00.000Z",
    });
    await insertConversation(db, {
      userId: "u-1",
      title: "middle",
      updatedAt: "2024-02-01T00:00:00.000Z",
    });

    const result = await models.getConversations("u-1");

    expect(result.ok).toBe(true);
    expectIsoDate(result.date);
    expect(result.data.map((row) => row.title)).toEqual([
      "newest",
      "middle",
      "older",
    ]);
  });

  it("never leaks another user's conversations", async () => {
    const { db, models } = harness;
    await insertConversation(db, { userId: "u-1", title: "mine" });
    await insertConversation(db, { userId: "u-2", title: "theirs" });

    const result = await models.getConversations("u-1");

    expect(result.data.map((row) => row.title)).toEqual(["mine"]);
  });

  it("applies limit and offset to the ordered page", async () => {
    const { db, models } = harness;
    for (const [index, title] of ["a", "b", "c", "d"].entries()) {
      await insertConversation(db, {
        userId: "u-1",
        title,
        updatedAt: `2024-01-0${String(index + 1)}T00:00:00.000Z`,
      });
    }

    const page = await models.getConversations("u-1", 2, 1);

    // Newest-first ordering means offset 1 starts at "c".
    expect(page.data.map((row) => row.title)).toEqual(["c", "b"]);
  });

  it("returns an empty page rather than throwing for an unknown user", async () => {
    const result = await harness.models.getConversations("nobody");

    expect(result).toEqual({ ok: true, date: result.date, data: [] });
    expectIsoDate(result.date);
  });

  it("aliases the timestamp columns to camelCase", async () => {
    const { db, models } = harness;
    await insertConversation(db, {
      userId: "u-1",
      title: "aliased",
      updatedAt: "2024-05-05T00:00:00.000Z",
    });

    const [row] = (await models.getConversations("u-1")).data;

    expect(Object.keys(row).sort()).toEqual([
      "createdAt",
      "id",
      "title",
      "updatedAt",
    ]);
    expect(row.updatedAt).toBe("2024-05-05T00:00:00.000Z");
  });
});

describe("getMessages", () => {
  it("returns the conversation's messages oldest first", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db);
    await insertMessage(db, {
      conversationId,
      role: "assistant",
      content: "second",
      createdAt: "2024-01-01T00:00:02.000Z",
    });
    await insertMessage(db, {
      conversationId,
      role: "user",
      content: "first",
      createdAt: "2024-01-01T00:00:01.000Z",
    });

    const result = await models.getMessages("u-1", conversationId);

    expect(result.ok).toBe(true);
    expectIsoDate(result.date);
    expect(result.data?.map((row) => row.content)).toEqual(["first", "second"]);
  });

  it("refuses a conversation owned by somebody else", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db, { userId: "u-2" });

    const result = await models.getMessages("u-1", conversationId);

    expect(result).toEqual({
      ok: false,
      date: result.date,
      reason: "Conversation not found",
    });
  });

  it("reports a missing conversation the same way as a foreign one", async () => {
    const result = await harness.models.getMessages("u-1", 9_999);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "Conversation not found" });
  });

  it("round-trips the trace and tools columns", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db);
    const trace = {
      rounds: [{ index: 0, tools: ["search"] }],
      usage: { input: 3, output: 4 },
    };
    await insertMessage(db, {
      conversationId,
      role: "assistant",
      content: "traced",
      toolsUsed: ["search", "read"],
      trace,
    });

    const result = await models.getMessages("u-1", conversationId);
    const [row] = result.data ?? [];

    // The columns are `jsonb` on postgres and `text` on sqlite, so the reader
    // is `fromJson` — this is the assertion that keeps both branches honest.
    expect(fromJson(row.toolsUsed)).toEqual(["search", "read"]);
    expect(fromJson(row.trace)).toEqual(trace);
  });
});

describe("loadConversationHistory", () => {
  it("creates a conversation and truncates the title to 50 characters", async () => {
    const { db, models } = harness;
    const long = "x".repeat(80);

    const result = await models.loadConversationHistory("u-1", undefined, long);

    expect(result.ok).toBe(true);
    const created = await db
      .selectFrom("conversations")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(created.title).toBe(`${"x".repeat(50)}...`);
    expect(result.data).toEqual({ newConversationId: created.id });
    expect(created.user_id).toBe("u-1");
  });

  it("trims the title before appending the ellipsis", async () => {
    const { db, models } = harness;

    await models.loadConversationHistory("u-1", undefined, "   padded   ");

    const created = await db
      .selectFrom("conversations")
      .select("title")
      .executeTakeFirstOrThrow();
    expect(created.title).toBe("padded...");
  });

  it("replays the stored turns and the compaction state", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db);
    await db
      .updateTable("conversations")
      .set({
        compacted_summary: "a summary",
        compacted_through_message_id: 2,
      })
      .where("id", "=", conversationId)
      .execute();
    await insertMessage(db, { conversationId, role: "user", content: "hi" });
    await insertMessage(db, { conversationId, role: "assistant", content: "yo" });

    const result = await models.loadConversationHistory(
      "u-1",
      conversationId,
      "next",
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      existedId: conversationId,
      conversation: [
        { id: expect.any(Number) as number, role: "user", message: "hi", trace: null },
        { id: expect.any(Number) as number, role: "assistant", message: "yo", trace: null },
      ],
      compaction: { summary: "a summary", throughMessageId: 2 },
    });
  });

  it("reports a null compaction for a conversation that was never compacted", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db);

    const result = await models.loadConversationHistory(
      "u-1",
      conversationId,
      "next",
    );

    expect(result.data).toMatchObject({
      compaction: { summary: null, throughMessageId: null },
    });
  });

  it("drops roles that are neither user nor assistant", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db);
    await insertMessage(db, { conversationId, role: "user", content: "keep me" });
    await insertMessage(db, { conversationId, role: "tool", content: "drop me" });
    await insertMessage(db, { conversationId, role: "system", content: "drop me too" });

    const result = await models.loadConversationHistory(
      "u-1",
      conversationId,
      "next",
    );

    const messages = (result.data as { conversation: { message: string }[] })
      .conversation;
    expect(messages.map((message) => message.message)).toEqual(["keep me"]);
  });

  it("refuses a conversation owned by somebody else", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db, { userId: "u-2" });

    const result = await models.loadConversationHistory(
      "u-1",
      conversationId,
      "next",
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "Conversation not found",
    });
  });
});

describe("saveMessages", () => {
  it("stores a user message with its embedding", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db);
    const embedding = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

    await models.saveUserMessage(conversationId, "hello", embedding);

    const row = await db
      .selectFrom("messages")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("user");
    expect(row.content).toBe("hello");
    expect(row.conversation_id).toBe(conversationId);
    expect(row.embedding).not.toBeNull();
  });

  it("rejects an embedding of the wrong width", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db);

    await expect(
      models.saveUserMessage(conversationId, "hello", [1, 2, 3]),
    ).rejects.toThrow("Expected 8 dims, got 3");
  });

  it("stores a cached exchange as a user and an assistant row", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db);

    await models.saveCachedExchange(
      conversationId,
      "question",
      [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      "cached answer",
    );

    const rows = await db
      .selectFrom("messages")
      .select(["role", "content", "embedding"])
      .orderBy("id", "asc")
      .execute();
    expect(rows.map((row) => [row.role, row.content])).toEqual([
      ["user", "question"],
      ["assistant", "cached answer"],
    ]);
    // Only the user turn carries an embedding: the assistant turn is the cache
    // value, not a search key.
    expect(rows[1].embedding).toBeNull();
  });

  it("returns the new id and round-trips tools and trace", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db);
    const trace = { rounds: [{ index: 0 }] };

    const saved = await models.saveAssistantMessage({
      conversationId,
      content: "the answer",
      toolsUsed: ["search"],
      trace: trace as never,
    });

    if (saved === null) throw new Error("expected the message to be saved");
    const row = await db
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", saved.id)
      .executeTakeFirstOrThrow();
    expect(row.content).toBe("the answer");
    expect(fromJson(row.tools_used)).toEqual(["search"]);
    expect(fromJson(row.trace)).toEqual(trace);
  });

  it("swallows a write failure and logs it", async () => {
    const { models } = harness;

    // A foreign key that points nowhere is a real write failure, not a stub.
    const saved = await models.saveAssistantMessage({
      conversationId: 12_345,
      content: "orphan",
      toolsUsed: [],
      trace: null,
    });

    expect(saved).toBeNull();
    expect(libLog.error).toHaveBeenCalledWith(
      { err: expect.anything() },
      "Failed to save final assistant message",
    );
  });
});

describe("saveConversationCompaction", () => {
  it("writes the summary and the watermark", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db);

    const saved = await models.saveConversationCompaction(conversationId, {
      changed: true,
      summary: "condensed",
      throughMessageId: 7,
    });

    expect(saved).toBe(true);
    const row = await db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", conversationId)
      .executeTakeFirstOrThrow();
    expect(row.compacted_summary).toBe("condensed");
    expect(row.compacted_through_message_id).toBe(7);
    // Regression guard: binding a `Date` here threw
    // "SQLite3 can only bind numbers, strings, bigints, buffers, and null".
    expectIsoDate(row.updated_at as string);
  });

  it("does not touch the row when nothing changed", async () => {
    const { db, models } = harness;
    const conversationId = await insertConversation(db);
    const before = await db
      .selectFrom("conversations")
      .select("updated_at")
      .where("id", "=", conversationId)
      .executeTakeFirstOrThrow();

    const saved = await models.saveConversationCompaction(conversationId, {
      changed: false,
      summary: "ignored",
      throughMessageId: 1,
    });

    expect(saved).toBe(true);
    const after = await db
      .selectFrom("conversations")
      .select(["compacted_summary", "updated_at"])
      .where("id", "=", conversationId)
      .executeTakeFirstOrThrow();
    expect(after.compacted_summary).toBeNull();
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("returns false when the conversation does not exist", async () => {
    const saved = await harness.models.saveConversationCompaction(4_242, {
      changed: true,
      summary: "ghost",
      throughMessageId: 1,
    });

    expect(saved).toBe(false);
  });
});

describe("persistChatRun", () => {
  it("writes the assistant message and finishes the run", async () => {
    const { db } = harness;
    const { persistChatRun } = await import("../persistChatRun.js");
    const { createRun, getRunById } = await import("../runs.js");
    const conversationId = await insertConversation(db);
    await createRun({
      id: "run-1",
      kind: "chat",
      query: "a question",
      userId: "u-1",
      conversationId,
    });

    const trace = new TraceCollector<Record<string, unknown>>([]);
    trace.apply({ type: "chunk", text: "partial answer" });
    trace.addStep({
      id: "call-1",
      name: "search",
      args: {},
      ok: true,
      durationMs: 1,
      callIndex: 1,
      callTotal: 1,
      result: "ok",
      previewHidden: false,
    });
    trace.apply({ type: "reasoning", round: 0, delta: "thinking" });

    await persistChatRun({
      runId: "run-1",
      conversationId,
      trace,
      toolsUsed: ["search"],
      status: "finished",
    });

    const message = await db
      .selectFrom("messages")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(message.content).toBe(trace.fullResponse);
    expect(fromJson(message.tools_used)).toEqual(["search"]);

    const run = await getRunById("run-1");
    expect(run?.status).toBe("finished");
    expect(run?.message_id).toBe(message.id);
    expectIsoDate(run?.finished_at as string);
    // `partial` keeps the synthesis even when the caller lost the stream.
    expect(fromJson(run?.partial)).toMatchObject({ text: trace.fullResponse });
  });

  it("skips the message but still closes the run when nothing was produced", async () => {
    const { env } = harness;
    const db = env.mod.getDb();
    const { persistChatRun } = await import("../persistChatRun.js");
    const { createRun, getRunById } = await import("../runs.js");
    const conversationId = await insertConversation(db);
    await createRun({
      id: "run-2",
      kind: "chat",
      query: "a question",
      userId: "u-1",
      conversationId,
    });

    const trace = new TraceCollector<Record<string, unknown>>([]);

    await persistChatRun({
      runId: "run-2",
      conversationId,
      trace,
      toolsUsed: [],
      status: "aborted",
    });

    expect(await db.selectFrom("messages").selectAll().execute()).toEqual([]);
    const run = await getRunById("run-2");
    expect(run?.status).toBe("aborted");
    expect(run?.message_id).toBeNull();
  });

  it("records the error text on a failed run", async () => {
    const { env } = harness;
    const db = env.mod.getDb();
    const { persistChatRun } = await import("../persistChatRun.js");
    const { createRun, getRunById } = await import("../runs.js");
    const conversationId = await insertConversation(db);
    await createRun({
      id: "run-3",
      kind: "chat",
      query: "a question",
      userId: "u-1",
      conversationId,
    });

    await persistChatRun({
      runId: "run-3",
      conversationId,
      trace: new TraceCollector<Record<string, unknown>>([]),
      toolsUsed: [],
      status: "failed",
      error: "upstream exploded",
    });

    const run = await getRunById("run-3");
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("upstream exploded");
  });
});
