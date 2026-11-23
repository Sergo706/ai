import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type OpenAI from "openai";
import type { Kysely } from "kysely";

import type { Database } from "~/db/schema.js";
import { toJson, toVec } from "~/db/utils.js";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";
import { libLog, libLogger } from "~~/test/test-utils/logger";
import {
  embeddingFake,
  embeddingVector,
  installEmbeddingFake,
  offlineClient,
} from "~~/test/test-utils/streamLlm";

/**
 * The chat semantic cache.
 *
 * The cache is a correctness surface rather than a speed one: a false hit
 * replays somebody else's answer, and a poisoned-tool hit replays a tool result
 * whose side effects never happened. Both branches are asserted here.
 *
 * The embedding helpers it depends on are covered by `rag/__tests__`.
 */

type SemanticCache = typeof import("~/chat/semanticCacheReply.js");
type CacheModel = typeof import("../chatSemanticCache.js");

interface Harness {
  env: LoadedConfig;
  db: Kysely<Database>;
  cache: SemanticCache;
  model: CacheModel;
  fake: ReturnType<typeof embeddingFake>;
}

const DIMENSIONS = 8;

async function boot(dimensions = DIMENSIONS): Promise<Harness> {
  const client: OpenAI = offlineClient();
  const fake = embeddingFake(dimensions);
  installEmbeddingFake(client, fake);
  const env = await loadConfig({
    logger: libLogger,
    dimensions,
    overrides: {
      embeddingConfig: {
        client,
        dimensions,
        matchingModel: "test-matching",
        retrievalModel: "test-retrieval",
      },
    },
  });
  return {
    env,
    db: env.mod.getDb(),
    cache: await import("~/chat/semanticCacheReply.js"),
    model: await import("../chatSemanticCache.js"),
    fake,
  };
}

async function seedExchange(
  db: Kysely<Database>,
  args: {
    userId?: string;
    question: string;
    answer: string;
    toolsUsed?: string[];
    createdAt?: string;
    embedding?: number[] | null;
  },
): Promise<{ conversationId: number; userMessageId: number }> {
  const conversation = await db
    .insertInto("conversations")
    .values({ user_id: args.userId ?? "u-1", title: args.question })
    .returning("id")
    .executeTakeFirstOrThrow();

  const userMessage = await db
    .insertInto("messages")
    .values({
      conversation_id: conversation.id,
      role: "user",
      content: args.question,
      embedding: toVec(args.embedding ?? embeddingVector(args.question, DIMENSIONS)),
      ...(args.createdAt === undefined ? {} : { created_at: args.createdAt }),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await db
    .insertInto("messages")
    .values({
      conversation_id: conversation.id,
      role: "assistant",
      content: args.answer,
      tools_used: toJson(args.toolsUsed ?? []),
    })
    .execute();

  return { conversationId: conversation.id, userMessageId: userMessage.id };
}

/** A fresh conversation the cache may legitimately write the replay into. */
async function newConversation(db: Kysely<Database>): Promise<number> {
  const row = await db
    .insertInto("conversations")
    .values({ user_id: "u-1", title: "target" })
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
  harness.fake.inputs.length = 0;
});

describe("checkChatSemanticCache", () => {
  it("returns the stored answer for an identical question", async () => {
    const { db, model } = harness;
    const question = "how do I rotate a secret";
    await seedExchange(db, {
      question,
      answer: "use the vault",
    });

    const hit = await model.checkChatSemanticCache(
      embeddingVector(question, DIMENSIONS),
      0.9,
      24,
      [],
    );

    expect(hit).toMatchObject({ hit: true, content: "use the vault" });
    expect(hit.matchedMessageId).toEqual(expect.any(Number) as number);
  });

  it("misses when the nearest question is below the threshold", async () => {
    const { db, model } = harness;
    await seedExchange(db, { question: "unrelated", answer: "nope" });
    const orthogonal = Array.from({ length: DIMENSIONS }, (_, index) =>
      index === 0 ? 1 : 0,
    );

    const hit = await model.checkChatSemanticCache(orthogonal, 0.99, 24, []);

    expect(hit).toEqual({ hit: false });
  });

  it("misses when nothing has been cached", async () => {
    const hit = await harness.model.checkChatSemanticCache(
      embeddingVector("anything", DIMENSIONS),
      0.5,
      24,
      [],
    );

    expect(hit).toEqual({ hit: false });
  });

  it("misses when the assistant turn is empty", async () => {
    const { db, model } = harness;
    const question = "empty answer";
    const conversation = await db
      .insertInto("conversations")
      .values({ user_id: "u-1" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("messages")
      .values({
        conversation_id: conversation.id,
        role: "user",
        content: question,
        embedding: toVec(embeddingVector(question, DIMENSIONS)),
      })
      .execute();

    const hit = await model.checkChatSemanticCache(
      embeddingVector(question, DIMENSIONS),
      0.5,
      24,
      [],
    );

    expect(hit).toEqual({ hit: false });
  });

  it("misses when the cached reply used a poisoned tool", async () => {
    const { db, model } = harness;
    const question = "what is the weather";
    await seedExchange(db, {
      question,
      answer: "sunny",
      toolsUsed: ["web-search"],
    });

    const hit = await model.checkChatSemanticCache(
      embeddingVector(question, DIMENSIONS),
      0.5,
      undefined,
      ["web-search"],
    );

    expect(hit).toEqual({ hit: false });
  });

  it("hits when the cached reply used only benign tools", async () => {
    const { db, model } = harness;
    const question = "summarise this";
    await seedExchange(db, {
      question,
      answer: "a summary",
      toolsUsed: ["read-document"],
    });

    const hit = await model.checkChatSemanticCache(
      embeddingVector(question, DIMENSIONS),
      0.5,
      24,
      ["web-search"],
    );

    expect(hit).toMatchObject({ hit: true, content: "a summary" });
  });

  it("ignores a cached exchange older than the window", async () => {
    const { db, model } = harness;
    const question = "an old question";
    await seedExchange(db, {
      question,
      answer: "an old answer",
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString(),
    });

    const inWindow = await model.checkChatSemanticCache(
      embeddingVector(question, DIMENSIONS),
      0.5,
      24,
      [],
    );
    const wideWindow = await model.checkChatSemanticCache(
      embeddingVector(question, DIMENSIONS),
      0.5,
      72,
      [],
    );

    expect(inWindow).toEqual({ hit: false });
    expect(wideWindow).toMatchObject({ hit: true, content: "an old answer" });
  });

  it("pairs the answer that follows the matched question", async () => {
    const { db, model } = harness;
    const first = "first question";
    const conversation = await db
      .insertInto("conversations")
      .values({ user_id: "u-1" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("messages")
      .values({
        conversation_id: conversation.id,
        role: "user",
        content: first,
        embedding: toVec(embeddingVector(first, DIMENSIONS)),
      })
      .execute();
    await db
      .insertInto("messages")
      .values({
        conversation_id: conversation.id,
        role: "assistant",
        content: "the right answer",
        tools_used: toJson([]),
      })
      .execute();
    await db
      .insertInto("messages")
      .values({
        conversation_id: conversation.id,
        role: "assistant",
        content: "a later answer",
        tools_used: toJson([]),
      })
      .execute();

    const hit = await model.checkChatSemanticCache(
      embeddingVector(first, DIMENSIONS),
      0.5,
      24,
      [],
    );

    // The first assistant turn after the question is the answer to it.
    expect(hit).toMatchObject({ hit: true, content: "the right answer" });
  });
});

describe("tryCachedReply", () => {
  /** The logger production passes in; the cache logs through it. */
  const log = () => libLogger;

  it("replays a cached answer into the conversation", async () => {
    const { db, cache } = harness;
    const question = "how do I rotate a secret";
    const embedding = embeddingVector(question, DIMENSIONS);
    await seedExchange(db, { question, answer: "use the vault", embedding });
    const target = await newConversation(db);

    const result = await cache.tryCachedReply(["web-search"], {
      convId: target,
      message: question,
      embedding,
      log: log(),
      stream: false,
      similarity: 0.9,
      cacheWindowHours: 24,
    });

    expect(result).toMatchObject({ hit: true, content: "use the vault" });
  });

  it("returns a readable stream when the caller asked for one", async () => {
    const { db, cache } = harness;
    const question = "streamed question";
    const embedding = embeddingVector(question, DIMENSIONS);
    await seedExchange(db, { question, answer: "streamed answer", embedding });
    const target = await newConversation(db);

    const result = await cache.tryCachedReply([], {
      convId: target,
      message: question,
      embedding,
      log: log(),
      stream: true,
      similarity: 0.9,
      cacheWindowHours: 24,
    });

    expect(result).toBeInstanceOf(ReadableStream);
    const text = await new Response(result as ReadableStream).text();
    expect(text).toContain("streamed answer");
  });

  it("writes the replayed exchange into the target conversation", async () => {
    const { db, cache } = harness;
    const question = "a repeated question";
    const embedding = embeddingVector(question, DIMENSIONS);
    await seedExchange(db, { question, answer: "the cached answer", embedding });
    const target = await db
      .insertInto("conversations")
      .values({ user_id: "u-1", title: "target" })
      .returning("id")
      .executeTakeFirstOrThrow();

    await cache.tryCachedReply([], {
      convId: target.id,
      message: question,
      embedding,
      log: log(),
      stream: false,
      similarity: 0.9,
      cacheWindowHours: 24,
    });

    const rows = await db
      .selectFrom("messages")
      .select(["role", "content"])
      .where("conversation_id", "=", target.id)
      .orderBy("id", "asc")
      .execute();
    expect(rows).toEqual([
      { role: "user", content: question },
      { role: "assistant", content: "the cached answer" },
    ]);
  });

  it("returns null when the caller's evaluator says to skip", async () => {
    const { cache } = harness;
    const embedding = embeddingVector("skipped", DIMENSIONS);

    const result = await cache.tryCachedReply(
      [],
      {
        convId: 1,
        message: "skipped",
        embedding,
        log: log(),
        stream: false,
        similarity: 0.9,
        cacheWindowHours: 24,
      },
      () => true,
    );

    expect(result).toBeNull();
  });

  it("consults the evaluator when one is supplied", async () => {
    const { db, cache } = harness;
    const question = "evaluated question";
    const embedding = embeddingVector(question, DIMENSIONS);
    await seedExchange(db, { question, answer: "cached", embedding });
    const target = await newConversation(db);
    const seen: [number, string][] = [];

    await cache.tryCachedReply(
      [],
      {
        convId: target,
        message: question,
        embedding,
        log: log(),
        stream: false,
        similarity: 0.9,
        cacheWindowHours: 24,
      },
      (convId, message) => {
        seen.push([convId, message]);
        return false;
      },
    );

    expect(seen).toEqual([[target, question]]);
  });

  it("returns null on a miss", async () => {
    const { cache } = harness;

    const result = await cache.tryCachedReply([], {
      convId: 1,
      message: "never cached",
      embedding: embeddingVector("never cached", DIMENSIONS),
      log: log(),
      stream: false,
      similarity: 0.99,
      cacheWindowHours: 24,
    });

    expect(result).toBeNull();
  });

  it("skips a cached reply that used a poison tool", async () => {
    const { db, cache } = harness;
    const question = "what is the weather";
    const embedding = embeddingVector(question, DIMENSIONS);
    await seedExchange(db, {
      question,
      answer: "sunny",
      embedding,
      toolsUsed: ["web-search"],
    });

    const result = await cache.tryCachedReply(["web-search"], {
      convId: 1,
      message: question,
      embedding,
      log: log(),
      stream: false,
      similarity: 0.9,
      cacheWindowHours: 24,
    });

    expect(result).toBeNull();
  });

  it("logs the match id on a hit", async () => {
    const { db, cache } = harness;
    const question = "logged question";
    const embedding = embeddingVector(question, DIMENSIONS);
    const seeded = await seedExchange(db, {
      question,
      answer: "logged answer",
      embedding,
    });
    const target = await newConversation(db);

    await cache.tryCachedReply([], {
      convId: target,
      message: question,
      embedding,
      log: log(),
      stream: false,
      similarity: 0.9,
      cacheWindowHours: 24,
    });

    expect(libLog.info).toHaveBeenCalledWith(
      { convId: target, matchedId: seeded.userMessageId },
      "Semantic cache HIT",
    );
  });
});
