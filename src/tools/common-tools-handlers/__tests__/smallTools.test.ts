import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type OpenAI from "openai";
import type { Kysely } from "kysely";

import type { Database } from "~/db/schema.js";
import { toVec } from "~/db/utils.js";
import { calculateCosineSimilarity } from "~/utils/vectorMath.js";
import {
  DEFAULT_CHECKPOINT_VERSION,
  checkpoint,
  restore,
  parseCheckpoint,
} from "~/runs/checkpoint/index.js";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";
import { libLogger } from "~~/test/test-utils/logger";
import {
  embeddingFake,
  embeddingVector,
  installEmbeddingFake,
  offlineClient,
} from "~~/test/test-utils/streamLlm";
import { ToolExecutionContext } from "~~/src/types/ToolExecutionTypes";

/**
 * Small pure helpers plus the three document-oriented tool handlers.
 *
 * The handlers are exercised end to end against the real database rather than
 * against a stub of `readToolDocument`, because the interesting part is the
 * error mapping: a missing document, an out-of-range chunk window and a
 * validation failure all have to come back as distinct tool errors rather than
 * as thrown exceptions the agent loop would swallow.
 */

const DIMENSIONS = 8;

interface Tools {
  calculator: typeof import("~/tools/common-tools-handlers/calculator.js").calculator;
  searchDb: typeof import("~/tools/common-tools-handlers/searchDb.js").searchDb;
  getDocument: typeof import("~/tools/common-tools-handlers/getDocument.js").getDocument;
}

interface Harness {
  env: LoadedConfig;
  db: Kysely<Database>;
  tools: Tools;
  fake: ReturnType<typeof embeddingFake>;
}

async function boot(): Promise<Harness> {
  const client: OpenAI = offlineClient();
  const fake = embeddingFake(DIMENSIONS);
  installEmbeddingFake(client, fake);
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
  const tools: Tools = {
    ...(await import("~/tools/common-tools-handlers/calculator.js")),
    ...(await import("~/tools/common-tools-handlers/searchDb.js")),
    ...(await import("~/tools/common-tools-handlers/getDocument.js")),
  };
  return { env, db: env.mod.getDb(), tools, fake };
}

async function seedDocument(
  db: Kysely<Database>,
  args: {
    title?: string;
    rawContent?: string;
    userId?: string | null;
    hash?: string;
    chunks?: { index: number; text: string; embedding: number[] }[];
  } = {},
): Promise<number> {
  const document = await db
    .insertInto("documents")
    .values({
      title: args.title ?? "a document",
      raw_content: args.rawContent ?? "the body",
      content_hash: args.hash ?? `hash-${String(Math.random()).slice(2)}`,
      user_id: args.userId === undefined ? "u-1" : args.userId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  if (args.chunks !== undefined) {
    await db
      .insertInto("document_chunks")
      .values(
        args.chunks.map((chunk) => ({
          document_id: document.id,
          chunk_index: chunk.index,
          chunk_text: chunk.text,
          embedding: toVec(chunk.embedding),
        })),
      )
      .execute();
  }

  return document.id;
}

/**
 * `toolError` returns a JSON *string*, not an object — the agent loop hands tool
 * results to the model verbatim, so the only stable way to assert one is to
 * parse it.
 */
function toolErrorOf(result: unknown): { code: string; message: string } {
  expect(typeof result).toBe("string");
  const parsed = JSON.parse(result as string) as {
    error: { code: string; message: string };
  };
  return parsed.error;
}

let harness: Harness;

/** The context every handler receives; these tools only read their arguments. */
const ctx: ToolExecutionContext = {
  toolCallId: "call-1",
  callIndex: 1,
  callTotal: 1,
};

beforeAll(async () => {
  harness = await boot();
});

beforeEach(async () => {
  await harness.env.truncate();
  harness.fake.inputs.length = 0;
});

describe("vectorMath.calculateCosineSimilarity", () => {
  it("scores identical vectors as 1", () => {
    expect(calculateCosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("scores orthogonal vectors as 0", () => {
    expect(calculateCosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("scores opposite vectors as -1", () => {
    expect(calculateCosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("returns 0 for mismatched dimensions instead of throwing", () => {
    expect(calculateCosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  it("returns 0 when either vector is all zeros", () => {
    expect(calculateCosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(calculateCosineSimilarity([1, 2], [0, 0])).toBe(0);
  });

  it("returns 0 for two empty vectors", () => {
    expect(calculateCosineSimilarity([], [])).toBe(0);
  });
});

describe("checkpoint helpers", () => {
  it("wraps progress with the default version", () => {
    const wrapped = checkpoint({ phase: "collect", state: { urls: [] } });

    expect(wrapped).toEqual({
      version: DEFAULT_CHECKPOINT_VERSION,
      phase: "collect",
      roundsDone: undefined,
      state: { urls: [] },
    });
  });

  it("honours an explicit version and round count", () => {
    const wrapped = checkpoint({
      phase: "critique",
      state: { done: true },
      version: 3,
      roundsDone: 2,
    });

    expect(wrapped).toEqual({
      version: 3,
      phase: "critique",
      roundsDone: 2,
      state: { done: true },
    });
  });

  it("restores progress into the caller's own state object", () => {
    const target = { urls: [] as string[], budget: 10 };

    const returned = restore(
      target,
      { version: 1, phase: "collect", state: { urls: ["a"], budget: 99 } },
      (into, from) => {
        into.urls.push(...from.urls);
      },
    );

    // The same object is returned and mutated, so config-driven fields the
    // caller set survive the restore.
    expect(returned).toBe(target);
    expect(target).toEqual({ urls: ["a"], budget: 10 });
  });

  it("parses a checkpoint this build understands", () => {
    const spec = { version: 1, phases: ["collect", "critique"] as const };

    const parsed = parseCheckpoint(
      { version: 1, phase: "collect", roundsDone: 2, state: { urls: ["a"] } },
      spec,
    );

    expect(parsed).toEqual({
      version: 1,
      phase: "collect",
      roundsDone: 2,
      state: { urls: ["a"] },
    });
  });

  it("rejects a checkpoint from another version", () => {
    const spec = { version: 2, phases: ["collect"] as const };

    expect(
      parseCheckpoint({ version: 1, phase: "collect", state: {} }, spec),
    ).toBeNull();
  });

  it("rejects a phase this build no longer knows", () => {
    const spec = { version: 1, phases: ["collect"] as const };

    expect(
      parseCheckpoint({ version: 1, phase: "retired", state: {} }, spec),
    ).toBeNull();
  });

  it("rejects a non-object, a missing phase and a non-object state", () => {
    const spec = { version: 1, phases: ["collect"] as const };

    expect(parseCheckpoint("a string", spec)).toBeNull();
    expect(parseCheckpoint(null, spec)).toBeNull();
    expect(parseCheckpoint({ version: 1, state: {} }, spec)).toBeNull();
    expect(
      parseCheckpoint({ version: 1, phase: "collect", state: "flat" }, spec),
    ).toBeNull();
  });

  it("drops a roundsDone that is not a number", () => {
    const spec = { version: 1, phases: ["collect"] as const };

    const parsed = parseCheckpoint(
      { version: 1, phase: "collect", roundsDone: "two", state: {} },
      spec,
    );

    expect(parsed).toEqual({
      version: 1,
      phase: "collect",
      roundsDone: undefined,
      state: {},
    });
  });
});

describe("calculator tool", () => {
  it("evaluates an arithmetic expression", async () => {
    const handler = harness.tools.calculator();

    expect(await handler({ expression: "2 + 2" }, ctx)).toBe("4");
  });

  it("handles precedence and parentheses", async () => {
    const handler = harness.tools.calculator();

    expect(await handler({ expression: "(2 + 3) * 4" }, ctx)).toBe("20");
  });

  it("rejects a non-string expression", async () => {
    const handler = harness.tools.calculator();

    expect(toolErrorOf(await handler({ expression: 42 }, ctx))).toEqual({
      code: "INVALID_EXPRESSION",
      message: "Expression must be a string.",
    });
  });

  it("reports a math failure instead of throwing", async () => {
    const handler = harness.tools.calculator();

    const result = await handler({ expression: "2 +* 3" }, ctx);

    expect(toolErrorOf(result).code).toBe("MATH_EVALUATION_FAILED");
    expect(toolErrorOf(result).message).toBe("Value expected (char 4)");
  });
});

describe("searchDb tool", () => {
  it("maps database rows onto the tool's result shape", async () => {
    const { db, tools } = harness;
    const query = "indexed question";
    const vector = embeddingVector(query, DIMENSIONS);
    await seedDocument(db, {
      title: "the title",
      chunks: [{ index: 3, text: "the chunk", embedding: vector }],
    });

    const result = await tools.searchDb()(
      {
        query,
        limit: 5,
        offset: 0,
        similarity: 0.5,
      },
      ctx,
    );

    expect(result).toMatchObject({
      results: [
        {
          title: "the title",
          content: "the chunk",
          chunkIndex: 3,
          chunkId: expect.any(Number) as number,
          documentId: expect.any(Number) as number,
          similarity: expect.any(Number) as number,
        },
      ],
    });
  });

  it("returns an empty result list rather than an error on a miss", async () => {
    const result = await harness.tools.searchDb()(
      {
        query: "nothing indexed",
        limit: 5,
        offset: 0,
        similarity: 0.99,
      },
      ctx,
    );

    expect(result).toEqual({ results: [] });
  });

  it("reports a validation failure for a bad argument", async () => {
    const result = await harness.tools.searchDb()({ query: "q" }, ctx);

    expect(toolErrorOf(result).code).toBe("VALIDATION_ERROR");
    // The issues are serialised into the message so the model can self-correct.
    expect(JSON.parse(toolErrorOf(result).message)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["limit"] })]),
    );
  });

  it("reports a search failure instead of throwing", async () => {
    const { tools } = harness;
    // A limit the model rejects as out of range surfaces as a tool error.
    const result = await tools.searchDb()(
      {
        query: "q",
        limit: 500,
        offset: 0,
        similarity: 0.5,
      },
      ctx,
    );

    expect(toolErrorOf(result)).toEqual({
      code: "DB_SEARCH_FAILED",
      message: "Database search failed or returned an invalid response.",
    });
  });

  it("scopes searchDb results to userId when provided and searches all documents when omitted", async () => {
    const { db, tools } = harness;
    const query = "quarterly numbers";
    const vector = embeddingVector(query, DIMENSIONS);
    await seedDocument(db, {
      title: "u1 doc",
      userId: "u-1",
      chunks: [{ index: 0, text: "u1 revenue", embedding: vector }],
    });
    await seedDocument(db, {
      title: "u2 doc",
      userId: "u-2",
      chunks: [{ index: 0, text: "u2 revenue", embedding: vector }],
    });

    const scoped = (await tools.searchDb("u-1")(
      { query, limit: 5, offset: 0, similarity: 0.5 },
      ctx,
    )) as { results: { content: string }[] };
    expect(scoped.results.map((r) => r.content)).toEqual(["u1 revenue"]);

    const unscoped = (await tools.searchDb()(
      { query, limit: 5, offset: 0, similarity: 0.5 },
      ctx,
    )) as { results: { content: string }[] };
    expect(unscoped.results.map((r) => r.content).sort()).toEqual([
      "u1 revenue",
      "u2 revenue",
    ]);
  });
});

describe("getDocument tool", () => {
  it("returns the document body when no chunk window is asked for", async () => {
    const { db, tools } = harness;
    const documentId = await seedDocument(db, {
      title: "titled",
      rawContent: "the whole body",
    });

    const result = await tools.getDocument("u-1")({ documentId }, ctx);

    expect(result).toMatchObject({
      id: documentId,
      title: "titled",
      content: "the whole body",
      chunkCount: 0,
      nextChunkStart: null,
    });
  });

  it("reports NOT_FOUND for another user's document", async () => {
    const { db, tools } = harness;
    const documentId = await seedDocument(db, { userId: "u-2" });

    expect(
      toolErrorOf(await tools.getDocument("u-1")({ documentId }, ctx)),
    ).toEqual({
      code: "NOT_FOUND",
      message: "Document not found or access denied.",
    });
  });

  it("requires chunkStart and chunkEnd together", async () => {
    const { db, tools } = harness;
    const documentId = await seedDocument(db);

    const result = await tools.getDocument("u-1")(
      { documentId, chunkStart: 0 },
      ctx,
    );

    expect(toolErrorOf(result).code).toBe("VALIDATION_ERROR");
    expect(toolErrorOf(result).message).toBe(
      "Supply both inclusive chunk indexes, selecting at most 10 chunks.",
    );
  });

  it("rejects a chunkEnd before the chunkStart", async () => {
    const { db, tools } = harness;
    const documentId = await seedDocument(db);

    const result = await tools.getDocument("u-1")(
      {
        documentId,
        chunkStart: 3,
        chunkEnd: 1,
      },
      ctx,
    );

    expect(toolErrorOf(result).code).toBe("VALIDATION_ERROR");
  });

  it("rejects a window wider than the per-read ceiling", async () => {
    const { db, tools } = harness;
    const documentId = await seedDocument(db);

    // Ten chunks is the ceiling, so a range spanning eleven is refused.
    const result = await tools.getDocument("u-1")(
      {
        documentId,
        chunkStart: 0,
        chunkEnd: 10,
      },
      ctx,
    );

    expect(toolErrorOf(result).code).toBe("VALIDATION_ERROR");
  });

  it("accepts a window exactly at the ceiling", async () => {
    const { db, tools } = harness;
    const documentId = await seedDocument(db, {
      chunks: Array.from({ length: 10 }, (_, index) => ({
        index,
        text: `chunk ${String(index)}`,
        embedding: embeddingVector(`chunk ${String(index)}`, DIMENSIONS),
      })),
    });

    const result = await tools.getDocument("u-1")(
      {
        documentId,
        chunkStart: 0,
        chunkEnd: 9,
      },
      ctx,
    );

    expect(result).toMatchObject({ chunkStart: 0, chunkEnd: 9 });
    expect((result as { chunks: unknown[] }).chunks).toHaveLength(10);
  });

  it("reports a validation failure for a non-numeric id", async () => {
    const result = await harness.tools.getDocument("u-1")(
      { documentId: "one" },
      ctx,
    );

    expect(toolErrorOf(result).code).toBe("VALIDATION_ERROR");
  });

  it("forwards custom token ceilings to the reader", async () => {
    const { db, tools } = harness;
    const documentId = await seedDocument(db, { rawContent: "y".repeat(200) });

    const result = await tools.getDocument("u-1", {
      charsPerToken: 4,
      maxDocTokens: 5,
      chunkTokenCap: 5,
      maxChunksPerRead: 10,
    })({ documentId }, ctx);

    expect((result as { content: string }).content).toHaveLength(20);
  });

  it("reports DOCUMENT_FAILED when the read itself throws", async () => {
    const { db, tools } = harness;
    const documentId = await seedDocument(db);

    // Dropping the table mid-flight makes the read throw a real error rather
    // than return null, which is the branch this asserts.
    await db.schema.dropTable("document_chunks").execute();

    const result = await tools.getDocument("u-1")({ documentId }, ctx);

    expect(toolErrorOf(result)).toEqual({
      code: "DOCUMENT_FAILED",
      message: "Unable to retrieve document.",
    });
  });
});
