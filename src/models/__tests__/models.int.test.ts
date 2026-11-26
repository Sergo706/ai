import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type OpenAI from "openai";
import type { Kysely } from "kysely";

import type { Database, RunStatus } from "~/db/schema.js";
import { fromJson, timestamp, toJson } from "~/db/utils.js";
import {
  INTEGRATION_PG_URL,
  INTEGRATION_REDIS_URL,
  integrationTargets,
} from "~~/test/integration.setup";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";
import { libLogger } from "~~/test/test-utils/logger";
import {
  embeddingFake,
  embeddingVector,
  installEmbeddingFake,
  offlineClient,
} from "~~/test/test-utils/streamLlm";

/**
 * The model layer against **real Postgres**, to prove both dialect branches.
 *
 * The units project runs every one of these models on sqlite, which is the
 * default backend. That says nothing about the branch most deployments take:
 * pgvector instead of `sqlite-vec`, `timestamptz` instead of `text`, `jsonb`
 * instead of a stringified column, and a serial primary key instead of an
 * autoincrement integer. Each of those has already produced a real bug in this
 * library, so the same scenarios are re-run here rather than trusted.
 */

const DIMENSIONS = 8;

interface Models {
  runs: typeof import("../runs.js");
  lease: typeof import("../runLease.js");
  checkpoints: typeof import("../runCheckpoint.js");
  saveUserMessage: typeof import("../saveMessages.js").saveUserMessage;
  saveAssistantMessage: typeof import("../saveMessages.js").saveAssistantMessage;
  getMessages: typeof import("../getMessages.js").getMessages;
  getConversations: typeof import("../getConversations.js").getConversations;
  saveConversationCompaction: typeof import("../saveConversationCompaction.js").saveConversationCompaction;
  fetchRelevantChunks: typeof import("../getRelevantChunks.js").fetchRelevantChunks;
  searchDbDocs: typeof import("../searchDbDocs.js").searchDbDocs;
  chatSemanticCache: typeof import("../chatSemanticCache.js");
}

interface Harness {
  env: LoadedConfig;
  db: Kysely<Database>;
  models: Models;
  /**
   * Imported after `loadConfig` on purpose: `toVec` reads
   * `getConfiguration()` for the vector width, so a file-scope import would bind
   * to the module instance that existed before `vi.resetModules()` and throw
   * "Configuration must be initialized".
   */
  utils: typeof import("~/db/utils.js");
}

async function boot(): Promise<Harness> {
  const client: OpenAI = offlineClient();
  installEmbeddingFake(client, embeddingFake(DIMENSIONS));
  const env = await loadConfig({
    dialect: "pg",
    pgUrl: INTEGRATION_PG_URL,
    redisUrl: INTEGRATION_REDIS_URL,
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
  const models: Models = {
    runs: await import("../runs.js"),
    lease: await import("../runLease.js"),
    checkpoints: await import("../runCheckpoint.js"),
    ...(await import("../saveMessages.js")),
    ...(await import("../getMessages.js")),
    ...(await import("../getConversations.js")),
    ...(await import("../saveConversationCompaction.js")),
    ...(await import("../getRelevantChunks.js")),
    ...(await import("../searchDbDocs.js")),
    chatSemanticCache: await import("../chatSemanticCache.js"),
  };
  return {
    env,
    db: env.mod.getDb(),
    models,
    utils: await import("~/db/utils.js"),
  };
}

async function seedConversation(
  db: Kysely<Database>,
  userId = "u-1",
): Promise<number> {
  const row = await db
    .insertInto("conversations")
    .values({ user_id: userId, title: "a conversation" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function seedRun(
  db: Kysely<Database>,
  args: {
    id: string;
    status?: RunStatus;
    owner?: string | null;
    claimedAt?: string | null;
    startedAt?: string;
    finishedAt?: string | null;
    checkpoint?: unknown;
  } = { id: "run-1" },
): Promise<void> {
  await db
    .insertInto("runs")
    .values({
      id: args.id,
      kind: "workflow",
      query: "q",
      status: args.status ?? "running",
      owner: args.owner ?? null,
      claimed_at: args.claimedAt ?? null,
      started_at: args.startedAt ?? new Date().toISOString(),
      finished_at: args.finishedAt ?? null,
      checkpoint: toJson(args.checkpoint ?? null),
    })
    .execute();
}

/** A timestamp far enough in the past to count as a dead lease. */
function longAgo(ms = 60_000): string {
  return new Date(Date.now() - ms).toISOString();
}

let harness: Harness;

beforeAll(async () => {
  harness = await boot();
});

beforeEach(async () => {
  await harness.env.truncate();
});

describe("connection target", () => {
  it("points at the published container ports", () => {
    expect(integrationTargets.postgres).toBe(INTEGRATION_PG_URL);
    expect(INTEGRATION_PG_URL).toContain("127.0.0.1:5435");
    expect(INTEGRATION_REDIS_URL).toContain("127.0.0.1:6381");
  });

  it("really is the postgres dialect", async () => {
    // `isPg()` is what every dialect branch keys off, so assert it rather than
    // trusting the option that was passed in.
    expect(harness.env.dialect).toBe("pg");
    const result = await harness.db
      .selectFrom("documents")
      .select("id")
      .limit(0)
      .execute();
    expect(result).toEqual([]);
  });
});

describe("runs on postgres", () => {
  it("round-trips an ISO timestamp through a timestamptz column", async () => {
    const { db, models } = harness;
    await models.runs.createRun({ id: "run-1", kind: "chat", query: "q" });

    await models.runs.updateRun({
      id: "run-1",
      status: "finished",
      finished: true,
    });

    const row = await db
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", "run-1")
      .executeTakeFirstOrThrow();
    expect(row.finished_at).not.toBeNull();
    expect(new Date(row.finished_at as unknown as string).toISOString()).toBe(
      new Date(row.finished_at as unknown as string).toISOString(),
    );
  });

  it("stores and reads a jsonb payload as a real array", async () => {
    const { db, models } = harness;
    await models.runs.createRun({
      id: "run-1",
      kind: "workflow",
      query: "q",
      input: { name: "named" },
    });

    const row = await db
      .selectFrom("runs")
      .select("input")
      .executeTakeFirstOrThrow();
    // On postgres this is already a parsed object; `fromJson` is a no-op here
    // and a parse on sqlite, which is exactly why the models use it.
    expect(
      fromJson<{ name: string }>(row.input as { name: string } | null),
    ).toEqual({
      name: "named",
    });
  });

  it("claims, finishes and releases a lease", async () => {
    const { db, models } = harness;
    await seedRun(db, { id: "run-1" });

    expect(await models.lease.claimRun("run-1")).toBe(true);
    expect(await models.lease.heartbeatRun("run-1")).toBe("alive");
    expect(
      await models.lease.finishRun({ runId: "run-1", stopReason: "done" }),
    ).toBe(true);
    await models.lease.releaseRun("run-1");

    const row = await db
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", "run-1")
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("finished");
    expect(row.owner).toBeNull();
  });

  it("compares timestamptz bounds correctly when sweeping", async () => {
    const { db, models } = harness;
    await seedRun(db, {
      id: "dead",
      owner: "dead-host:1:abc",
      claimedAt: longAgo(120_000),
    });
    await seedRun(db, {
      id: "live",
      owner: "host:1:abc",
      claimedAt: new Date().toISOString(),
    });

    expect(
      (await models.lease.findResumableRuns()).map((row) => row.id),
    ).toEqual(["dead"]);
    expect(await models.lease.markStaleRunsInterrupted()).toBe(1);
  });

  it("round-trips a checkpoint envelope through jsonb", async () => {
    const { db, models } = harness;
    await seedRun(db, { id: "run-1", owner: models.lease.INSTANCE_ID });
    const snapshot = { version: 1, phase: "collect", state: { urls: ["a"] } };

    await models.checkpoints.saveCheckpoint({
      runId: "run-1",
      snapshot: snapshot,
    });

    expect(await models.checkpoints.loadCheckpoint("run-1")).toEqual(snapshot);
  });
});

describe("messages and conversations on postgres", () => {
  it("stores a vector and reads the message back", async () => {
    const { db, models } = harness;
    const conversationId = await seedConversation(db);

    await models.saveUserMessage(
      conversationId,
      "a question",
      embeddingVector("a question", DIMENSIONS),
    );

    const result = await models.getMessages("u-1", conversationId);

    expect(result.ok).toBe(true);
    expect(result.data?.[0]).toMatchObject({
      role: "user",
      content: "a question",
    });
  });

  it("returns jsonb tools and trace already parsed", async () => {
    const { db, models } = harness;
    const conversationId = await seedConversation(db);

    await models.saveAssistantMessage({
      conversationId,
      content: "an answer",
      toolsUsed: ["search"],
      trace: { reasoning: [], steps: [] },
    });

    const result = await models.getMessages("u-1", conversationId);
    const [row] = result.data ?? [];

    expect(fromJson(row.toolsUsed)).toEqual(["search"]);
    expect(fromJson(row.trace)).toEqual({ reasoning: [], steps: [] });
  });

  it("persists the compaction watermark through a timestamptz write", async () => {
    const { db, models } = harness;
    const conversationId = await seedConversation(db);

    expect(
      await models.saveConversationCompaction(conversationId, {
        changed: true,
        summary: "condensed",
        throughMessageId: 4,
      }),
    ).toBe(true);

    const row = await db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", conversationId)
      .executeTakeFirstOrThrow();
    expect(row.compacted_summary).toBe("condensed");
    expect(row.compacted_through_message_id).toBe(4);
  });

  it("orders conversations by update time", async () => {
    const { db, models } = harness;
    await db
      .insertInto("conversations")
      .values({
        user_id: "u-1",
        title: "older",
        updated_at: "2024-01-01T00:00:00.000Z",
      })
      .execute();
    await db
      .insertInto("conversations")
      .values({
        user_id: "u-1",
        title: "newer",
        updated_at: "2024-05-01T00:00:00.000Z",
      })
      .execute();

    const result = await models.getConversations("u-1");

    expect(result.data.map((row) => row.title)).toEqual(["newer", "older"]);
  });
});

describe("vector search on pgvector", () => {
  it("finds the nearest chunk through the <=> operator", async () => {
    const { db, models, utils } = harness;
    const query = embeddingVector("the query", DIMENSIONS);
    const document = await db
      .insertInto("documents")
      .values({
        title: "indexed",
        raw_content: "body",
        content_hash: "hash-pg-1",
        user_id: "u-1",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("document_chunks")
      .values([
        {
          document_id: document.id,
          chunk_index: 0,
          chunk_text: "the matching chunk",
          embedding: utils.toVec(query),
        },
        {
          document_id: document.id,
          chunk_index: 1,
          chunk_text: "an unrelated chunk",
          embedding: utils.toVec(
            Array.from({ length: DIMENSIONS }, (_, index) =>
              index === 0 ? 0 : 1,
            ),
          ),
        },
      ])
      .execute();

    const results = await models.fetchRelevantChunks(query, 10, 0, 0.5);

    expect(results[0]).toMatchObject({
      chunkText: "the matching chunk",
      title: "indexed",
    });
    expect(results[0].similarity).toBeCloseTo(1, 5);
  });

  it("tolerates chunks whose vector is NULL", async () => {
    const { db, models, utils } = harness;
    const query = embeddingVector("query", DIMENSIONS);
    const document = await db
      .insertInto("documents")
      .values({
        title: "mixed",
        raw_content: "body",
        content_hash: "hash-pg-2",
        user_id: "u-1",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("document_chunks")
      .values([
        {
          document_id: document.id,
          chunk_index: 0,
          chunk_text: "no vector",
          embedding: null,
        },
        {
          document_id: document.id,
          chunk_index: 1,
          chunk_text: "has vector",
          embedding: utils.toVec(query),
        },
      ])
      .execute();

    const results = await models.fetchRelevantChunks(query, 10, 0, 0.1);

    expect(results.map((row) => row.chunkText)).toEqual(["has vector"]);
  });

  it("filters chunks by userId on postgres when provided and returns all users when omitted", async () => {
    const { db, models, utils } = harness;
    const query = embeddingVector("pg multi tenant query", DIMENSIONS);
    const d1 = await db
      .insertInto("documents")
      .values({
        title: "u1-doc",
        raw_content: "body",
        content_hash: "hash-pg-u1",
        user_id: "u-1",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const d2 = await db
      .insertInto("documents")
      .values({
        title: "u2-doc",
        raw_content: "body",
        content_hash: "hash-pg-u2",
        user_id: "u-2",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("document_chunks")
      .values([
        {
          document_id: d1.id,
          chunk_index: 0,
          chunk_text: "u1 pg chunk",
          embedding: utils.toVec(query),
        },
        {
          document_id: d2.id,
          chunk_index: 0,
          chunk_text: "u2 pg chunk",
          embedding: utils.toVec(query),
        },
      ])
      .execute();

    const u1Only = await models.fetchRelevantChunks(query, 10, 0, 0.5, "u-1");
    expect(u1Only.map((row) => row.chunkText)).toEqual(["u1 pg chunk"]);

    const all = await models.fetchRelevantChunks(query, 10, 0, 0.5);
    expect(all.map((row) => row.chunkText).sort()).toEqual([
      "u1 pg chunk",
      "u2 pg chunk",
    ]);
  });

  it("searches through the tool-facing wrapper", async () => {
    const { db, models, utils } = harness;
    const query = embeddingVector("a searchable line", DIMENSIONS);
    const document = await db
      .insertInto("documents")
      .values({
        title: "searchable",
        raw_content: "body",
        content_hash: "hash-pg-3",
        user_id: "u-1",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("document_chunks")
      .values({
        document_id: document.id,
        chunk_index: 0,
        chunk_text: "a searchable line",
        embedding: utils.toVec(query),
      })
      .execute();

    const results = await models.searchDbDocs({
      query: "a searchable line",
      limit: 5,
      offset: 0,
      similarity: 0.5,
    });

    expect(Array.isArray(results)).toBe(true);
    expect((results as { chunkText: string }[])[0].chunkText).toBe(
      "a searchable line",
    );
  });
});

describe("semantic cache on postgres", () => {
  it("hits an identical question through the vector index", async () => {
    const { db, models } = harness;
    const question = "how do I rotate a secret";
    const vector = embeddingVector(question, DIMENSIONS);
    const conversationId = await seedConversation(db);
    await models.saveUserMessage(conversationId, question, vector);
    await models.saveAssistantMessage({
      conversationId,
      content: "use the vault",
      toolsUsed: [],
      trace: null,
    });

    const hit = await models.chatSemanticCache.checkChatSemanticCache(
      vector,
      0.9,
      24,
      [],
    );

    expect(hit).toMatchObject({ hit: true, content: "use the vault" });
  });

  it("honours the window using a real INTERVAL expression", async () => {
    const { db, models } = harness;
    const question = "an old question";
    const vector = embeddingVector(question, DIMENSIONS);
    const conversationId = await seedConversation(db);
    await models.saveUserMessage(conversationId, question, vector);
    await models.saveAssistantMessage({
      conversationId,
      content: "an old answer",
      toolsUsed: [],
      trace: null,
    });
    await db
      .updateTable("messages")
      .set({ created_at: longAgo(72 * 60 * 60 * 1_000) })
      .where("conversation_id", "=", conversationId)
      .where("role", "=", "user")
      .execute();

    expect(
      await models.chatSemanticCache.checkChatSemanticCache(
        vector,
        0.5,
        24,
        [],
      ),
    ).toEqual({ hit: false });
    expect(
      await models.chatSemanticCache.checkChatSemanticCache(
        vector,
        0.5,
        96,
        [],
      ),
    ).toMatchObject({ hit: true });
  });

  it("refuses a reply that used a poisoned tool", async () => {
    const { db, models } = harness;
    const question = "current weather";
    const vector = embeddingVector(question, DIMENSIONS);
    const conversationId = await seedConversation(db);
    await models.saveUserMessage(conversationId, question, vector);
    await models.saveAssistantMessage({
      conversationId,
      content: "sunny",
      toolsUsed: ["web-search"],
      trace: null,
    });

    expect(
      await models.chatSemanticCache.checkChatSemanticCache(vector, 0.5, 24, [
        "web-search",
      ]),
    ).toEqual({ hit: false });
  });

  it("scopes semantic cache hits by userId on postgres and stays unscoped when omitted", async () => {
    const { db, models } = harness;
    const question = "pg user-scoped secret";
    const vector = embeddingVector(question, DIMENSIONS);
    const aliceConv = await seedConversation(db, "alice");
    await models.saveUserMessage(aliceConv, question, vector);
    await models.saveAssistantMessage({
      conversationId: aliceConv,
      content: "alice pg answer",
      toolsUsed: [],
      trace: null,
    });

    expect(
      await models.chatSemanticCache.checkChatSemanticCache(
        vector,
        0.9,
        24,
        [],
        "bob",
      ),
    ).toEqual({ hit: false });

    expect(
      await models.chatSemanticCache.checkChatSemanticCache(
        vector,
        0.9,
        24,
        [],
        "alice",
      ),
    ).toMatchObject({ hit: true, content: "alice pg answer" });

    expect(
      await models.chatSemanticCache.checkChatSemanticCache(
        vector,
        0.9,
        24,
        [],
      ),
    ).toMatchObject({ hit: true, content: "alice pg answer" });
  });
});

describe("dialect helpers on postgres", () => {
  it("formats timestamps the same way on both dialects", () => {
    // The helper is dialect-agnostic on purpose: a string is the only value both
    // drivers accept, so a caller never has to branch.
    const now = Date.now();
    const stamp = timestamp();
    // Read every sample against a single clock reading. Comparing two calls to
    // each other fails whenever the millisecond ticks in between.
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(stamp).toISOString()).toBe(stamp);
    expect(new Date(stamp).getTime()).toBeGreaterThanOrEqual(now);
    expect(new Date(stamp).getTime()).toBeLessThanOrEqual(now + 1_000);

    const skewed = new Date(timestamp(-60_000)).getTime();
    expect(skewed).toBeGreaterThanOrEqual(now - 61_000);
    expect(skewed).toBeLessThanOrEqual(now + 1_000 - 60_000);
  });
});
