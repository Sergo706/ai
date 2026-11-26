import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fromJson, toJson, toVec } from "~/db/utils.js";
import { clearRuns, registerRun } from "~/runs/runRegistry.js";
import { streamFromRun } from "~/runs/streamFromRun.js";
import {
  libLog,
  libLogger,
  resetLibLogger,
} from "~~/test/test-utils/logger.js";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config.js";
import {
  embeddingFake,
  embeddingVector,
  installEmbeddingFake,
  offlineClient,
} from "~~/test/test-utils/streamLlm.js";

/**
 * `cachedTurn` is the semantic-cache shortcut in front of a chat turn.
 *
 * Everything here runs against the real sqlite database and the real
 * `checkChatSemanticCache` query; only the embedding provider is faked, because
 * it is a paid network boundary and the vector it returns is the *input* to the
 * search rather than the behaviour under test.
 */

const DIMENSIONS = 8;

type CachedTurn = typeof import("~/agents/cachedTurn.js");
type Db = ReturnType<LoadedConfig["mod"]["getDb"]>;

let env: LoadedConfig;
let cachedTurn: CachedTurn["cachedTurn"];
let db: Db;
let fake: ReturnType<typeof embeddingFake>;

/** Creates an empty conversation the cache may write a replay into. */
async function newConversation(userId = "u-cache"): Promise<number> {
  const row = await db
    .insertInto("conversations")
    .values({ user_id: userId, title: "cache" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Stores one earlier exchange, embedding the user message with the vector the
 * fake provider will produce for the same text. That is what makes a repeat of
 * `question` a hit.
 */
async function seedExchange(args: {
  conversationId: number;
  question: string;
  answer: string;
  toolsUsed?: string[];
}): Promise<void> {
  await db
    .insertInto("messages")
    .values({
      conversation_id: args.conversationId,
      role: "user",
      content: args.question,
      embedding: toVec(embeddingVector(args.question, DIMENSIONS)),
    })
    .execute();

  await db
    .insertInto("messages")
    .values({
      conversation_id: args.conversationId,
      role: "assistant",
      content: args.answer,
      tools_used: toJson(args.toolsUsed ?? []),
    })
    .execute();
}

async function messageCount(conversationId: number): Promise<number> {
  const row = await db
    .selectFrom("messages")
    .select(({ fn }) => fn.countAll<number>().as("n"))
    .where("conversation_id", "=", conversationId)
    .executeTakeFirstOrThrow();
  return row.n;
}

beforeEach(async () => {
  resetLibLogger();
  const client = offlineClient();
  fake = embeddingFake(DIMENSIONS);
  installEmbeddingFake(client, fake);
  env = await loadConfig({
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
  db = env.mod.getDb();
  cachedTurn = (await import("~/agents/cachedTurn.js")).cachedTurn;
  fake.inputs.length = 0;
});

afterEach(() => {
  clearRuns();
});

describe("cachedTurn", () => {
  it("returns null when semantic caching is not configured", async () => {
    const conversationId = await newConversation();
    expect(
      await cachedTurn({
        options: undefined,
        conversationId,
        hasFiles: false,
        message: "hello",
        log: libLogger,
      }),
    ).toBeNull();
    // The cheap guards run before the provider is ever called.
    expect(fake.inputs).toEqual([]);
  });

  it("returns null when there is no conversation to search", async () => {
    expect(
      await cachedTurn({
        options: {},
        conversationId: undefined,
        hasFiles: false,
        message: "hello",
        log: libLogger,
      }),
    ).toBeNull();
    expect(fake.inputs).toEqual([]);
  });

  it("returns null when the turn carries files", async () => {
    const conversationId = await newConversation();
    expect(
      await cachedTurn({
        options: {},
        conversationId,
        hasFiles: true,
        message: "hello",
        log: libLogger,
      }),
    ).toBeNull();
    // Attachment text is inlined into the stored message, so caching is unsafe.
    expect(fake.inputs).toEqual([]);
  });

  it("creates a finished run row and replayable RunHandle on a managed cache hit", async () => {
    const source = await newConversation("u-run");
    const target = await newConversation("u-run");
    const message = "what is the capital of France";
    await seedExchange({
      conversationId: source,
      question: message,
      answer: "Paris",
    });

    const run = registerRun({
      id: "run-cached-1",
      kind: "chat",
      conversationId: target,
      status: "running",
      startedAt: Date.now(),
    });

    const stream = await cachedTurn({
      options: {},
      conversationId: target,
      userId: "u-run",
      hasFiles: false,
      message,
      log: libLogger,
      run,
      runName: "supportAgent",
    });

    if (stream === null) throw new Error("expected a managed cached stream");

    const frames: unknown[] = [];
    for await (const frame of stream.frames) frames.push(frame);
    expect(frames).toEqual([
      { type: "init", conversationId: target },
      { type: "chunk", text: "Paris" },
      { type: "done" },
    ]);

    expect(await stream.done).toEqual({
      runId: "run-cached-1",
      conversationId: target,
      text: "Paris",
      toolsUsed: [],
      trace: null,
      cached: true,
    });

    expect(run.status).toBe("finished");
    expect(run.events).toEqual([
      { type: "chunk", text: "Paris" },
      { type: "done" },
    ]);
    expect(run.eventIds).toHaveLength(2);
    expect(run.disposal).toBeTypeOf("function");

    const row = await db
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", "run-cached-1")
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe("chat");
    expect(row.query).toBe(message);
    expect(row.user_id).toBe("u-run");
    expect(row.conversation_id).toBe(target);
    expect(row.status).toBe("finished");
    expect(row.finished_at).not.toBeNull();
    expect(row.owner).toBeNull();
    expect(row.claimed_at).toBeNull();
    expect(
      fromJson<{ name: string }>(row.input as { name: string } | null),
    ).toEqual({
      name: "supportAgent",
    });
    expect(
      fromJson<{ text: string }>(row.partial as { text: string } | null),
    ).toEqual({
      text: "Paris",
    });

    // Reattaching via streamFromRun replays the cached run and closes cleanly.
    const replayStream = streamFromRun({
      run,
      conversationId: target,
      runId: run.id,
      log: libLogger,
    });
    const reader = replayStream.getReader();
    const decoder = new TextDecoder();
    let sse = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sse += decoder.decode(value, { stream: true });
    }
    expect(sse).toContain(`"runId":"run-cached-1"`);
    expect(sse).toContain(`"type":"chunk","text":"Paris"`);
    expect(sse).toContain(`"type":"done"`);
  });

  it("leaves a managed run untouched when the cache misses", async () => {
    const conversationId = await newConversation();
    const run = registerRun({
      id: "run-miss-1",
      kind: "chat",
      conversationId,
      status: "running",
      startedAt: Date.now(),
    });

    expect(
      await cachedTurn({
        options: {},
        conversationId,
        hasFiles: false,
        message: "never asked before",
        log: libLogger,
        run,
      }),
    ).toBeNull();

    expect(run.status).toBe("running");
    expect(run.events).toEqual([]);
    const row = await db
      .selectFrom("runs")
      .select("id")
      .where("id", "=", "run-miss-1")
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it("returns null when nothing similar is cached", async () => {
    const conversationId = await newConversation();
    expect(
      await cachedTurn({
        options: {},
        conversationId,
        hasFiles: false,
        message: "a question nobody asked before",
        log: libLogger,
      }),
    ).toBeNull();
    // It did look, because none of the guards applied.
    expect(fake.inputs).toEqual(["a question nobody asked before"]);
  });

  it("replays a cached answer as init, chunk and done frames", async () => {
    const source = await newConversation();
    const target = await newConversation();
    const message = "what is the capital of France";
    await seedExchange({
      conversationId: source,
      question: message,
      answer: "Paris",
    });

    const stream = await cachedTurn({
      options: {},
      conversationId: target,
      hasFiles: false,
      message,
      log: libLogger,
    });

    if (stream === null) throw new Error("expected a cached stream");
    const frames: unknown[] = [];
    for await (const frame of stream.frames) frames.push(frame);

    expect(frames).toEqual([
      { type: "init", conversationId: target },
      { type: "chunk", text: "Paris" },
      { type: "done" },
    ]);

    expect(await stream.done).toEqual({
      runId: undefined,
      conversationId: target,
      text: "Paris",
      toolsUsed: [],
      trace: null,
      cached: true,
    });
  });

  it("honours the skip evaluator and never searches", async () => {
    const source = await newConversation();
    const target = await newConversation();
    const message = "a question with a cached answer";
    await seedExchange({
      conversationId: source,
      question: message,
      answer: "answer",
    });

    const seen: { conversationId: number; message: string }[] = [];
    expect(
      await cachedTurn({
        options: {
          skipEvaluator: (conversationId, text) => {
            seen.push({ conversationId, message: text });
            return true;
          },
        },
        conversationId: target,
        hasFiles: false,
        message,
        log: libLogger,
      }),
    ).toBeNull();

    expect(seen).toEqual([{ conversationId: target, message }]);
    // The embedding is generated first — `tryCachedReply` is what consults the
    // skip evaluator — so exactly one call was made and the search never ran.
    expect(fake.inputs).toEqual([message]);
  });

  it("proceeds when the skip evaluator returns false", async () => {
    const source = await newConversation();
    const target = await newConversation();
    const message = "still cacheable";
    await seedExchange({
      conversationId: source,
      question: message,
      answer: "yes",
    });

    expect(
      await cachedTurn({
        options: { skipEvaluator: () => false },
        conversationId: target,
        hasFiles: false,
        message,
        log: libLogger,
      }),
    ).not.toBeNull();
  });

  it("refuses to reuse an answer that used a poisoned tool", async () => {
    const source = await newConversation();
    const target = await newConversation();
    const message = "what time is it";
    await seedExchange({
      conversationId: source,
      question: message,
      answer: "Noon",
      toolsUsed: ["getCurrentDatetime"],
    });

    // Without the poison list the stored answer is served...
    expect(
      await cachedTurn({
        options: {},
        conversationId: target,
        hasFiles: false,
        message,
        log: libLogger,
      }),
    ).not.toBeNull();

    // ...and with it the turn falls through to the live model, because replaying
    // a tool result whose side effects never happened would be a lie.
    expect(
      await cachedTurn({
        options: { poisonTools: ["getCurrentDatetime"] },
        conversationId: target,
        hasFiles: false,
        message,
        log: libLogger,
      }),
    ).toBeNull();
  });

  it("still hits when the stored answer used a different tool", async () => {
    const source = await newConversation();
    const target = await newConversation();
    const message = "date please";
    await seedExchange({
      conversationId: source,
      question: message,
      answer: "Monday",
      toolsUsed: ["getCurrentDatetime"],
    });

    expect(
      await cachedTurn({
        options: { poisonTools: ["someOtherTool"] },
        conversationId: target,
        hasFiles: false,
        message,
        log: libLogger,
      }),
    ).not.toBeNull();
  });

  it("records the replayed exchange so the conversation stays coherent", async () => {
    const source = await newConversation();
    const target = await newConversation();
    const message = "repeat me";
    await seedExchange({
      conversationId: source,
      question: message,
      answer: "repeated",
    });

    expect(await messageCount(target)).toBe(0);

    await cachedTurn({
      options: {},
      conversationId: target,
      hasFiles: false,
      message,
      log: libLogger,
    });

    // The user question and the replayed answer are written into the *target*
    // conversation, so the next live turn has both sides of the exchange.
    expect(await messageCount(target)).toBe(2);
    expect(libLog.info).toHaveBeenCalledWith(
      { convId: target, matchedId: expect.any(Number) as number },
      "Semantic cache HIT",
    );

    const stored = await db
      .selectFrom("messages")
      .select(["role", "content"])
      .where("conversation_id", "=", target)
      .orderBy("id", "asc")
      .execute();
    expect(stored).toEqual([
      { role: "user", content: message },
      { role: "assistant", content: "repeated" },
    ]);
  });

  it("uses the configured similarity and window", async () => {
    const source = await newConversation();
    const target = await newConversation();
    const message = "how tall is Everest";
    await seedExchange({
      conversationId: source,
      question: message,
      answer: "8848 m",
    });

    // An exact vector match clears any threshold, so a hit proves the plumbing
    // passes the options through rather than ignoring them.
    expect(
      await cachedTurn({
        options: { similarity: 0.99, windowHours: 1 },
        conversationId: target,
        hasFiles: false,
        message,
        log: libLogger,
      }),
    ).not.toBeNull();
  });

  it("isolates cached replies per userId when userId is provided", async () => {
    const aliceConv = await newConversation("alice");
    const bobConv = await newConversation("bob");
    const aliceNext = await newConversation("alice");
    const message = "my private notes";
    await seedExchange({
      conversationId: aliceConv,
      question: message,
      answer: "Alice private answer",
    });

    // Bob must miss Alice's cached turn when userId is supplied.
    expect(
      await cachedTurn({
        options: {},
        conversationId: bobConv,
        userId: "bob",
        hasFiles: false,
        message,
        log: libLogger,
      }),
    ).toBeNull();

    // Alice hits her own cached turn.
    const hit = await cachedTurn({
      options: {},
      conversationId: aliceNext,
      userId: "alice",
      hasFiles: false,
      message,
      log: libLogger,
    });
    if (hit === null) throw new Error("expected alice to hit her own cache");
    expect((await hit.done).text).toBe("Alice private answer");
  });
});
