import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Kysely } from "kysely";

import type { Database } from "~/db/schema.js";
import { toVec } from "~/db/utils.js";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";
import { libLogger } from "~~/test/test-utils/logger";
import {
  embeddingFake,
  embeddingVector,
  installEmbeddingFake,
  offlineClient,
} from "~~/test/test-utils/streamLlm";
import type OpenAI from "openai";

/**
 * Retrieval models: vector search, document reading and ingestion.
 *
 * These are the paths where a dialect difference is most likely to hide, because
 * the vector column is a `vector(n)` on postgres and a `blob` on sqlite and the
 * distance operator differs between them. Both branches are exercised by the
 * same suite, so a change that only works on one dialect fails here.
 *
 * The embedding transport is the only fake: `sqlite-vec` and pgvector run for
 * real, which is the whole point of the suite.
 */

interface Models {
  fetchRelevantChunks: typeof import("../getRelevantChunks.js").fetchRelevantChunks;
  searchDbDocs: typeof import("../searchDbDocs.js").searchDbDocs;
  readToolDocument: typeof import("../toolContent.js").readToolDocument;
  saveUploadedScrappedFile: typeof import("../saveUploadedScrapedFile.js").saveUploadedScrappedFile;
}

interface Harness {
  env: LoadedConfig;
  db: Kysely<Database>;
  models: Models;
  embedding: ReturnType<typeof embeddingFake>;
}

const DIMENSIONS = 8;

async function boot(): Promise<Harness> {
  const embeddings: OpenAI = offlineClient();
  const embedding = embeddingFake(DIMENSIONS);
  installEmbeddingFake(embeddings, embedding);
  const env = await loadConfig({
    logger: libLogger,
    dimensions: DIMENSIONS,
    overrides: {
      embeddingConfig: {
        client: embeddings,
        dimensions: DIMENSIONS,
        matchingModel: "test-matching",
        retrievalModel: "test-retrieval",
      },
    },
  });
  const models: Models = {
    ...(await import("../getRelevantChunks.js")),
    ...(await import("../searchDbDocs.js")),
    ...(await import("../toolContent.js")),
    ...(await import("../saveUploadedScrapedFile.js")),
  };
  return { env, db: env.mod.getDb(), models, embedding };
}

/**
 * A vector pointing along one axis, so cosine distance is exactly predictable:
 * the same axis is distance 0 and an orthogonal axis is distance 1.
 */
function axis(index: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, position) =>
    position === index ? 1 : 0,
  );
}

async function insertDocument(
  db: Kysely<Database>,
  args: {
    title?: string;
    rawContent?: string;
    userId?: string | null;
    hash?: string;
    createdAt?: string;
    chunks?: { index: number; text: string; embedding?: number[] | null }[];
  } = {},
): Promise<number> {
  const document = await db
    .insertInto("documents")
    .values({
      title: args.title ?? "a document",
      raw_content: args.rawContent ?? "document body",
      content_hash: args.hash ?? `hash-${String(Math.random()).slice(2)}`,
      user_id: args.userId === undefined ? "u-1" : args.userId,
      ...(args.createdAt === undefined ? {} : { created_at: args.createdAt }),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const chunks = args.chunks ?? [];
  if (chunks.length > 0) {
    await db
      .insertInto("document_chunks")
      .values(
        chunks.map((chunk) => ({
          document_id: document.id,
          chunk_index: chunk.index,
          chunk_text: chunk.text,
          embedding:
            chunk.embedding === undefined || chunk.embedding === null
              ? null
              : toVec(chunk.embedding),
        })),
      )
      .execute();
  }

  return document.id;
}

let harness: Harness;

beforeAll(async () => {
  harness = await boot();
});

beforeEach(async () => {
  await harness.env.truncate();
  harness.embedding.inputs.length = 0;
});

describe("fetchRelevantChunks", () => {
  it("returns the nearest chunk first with a similarity score", async () => {
    const { db, models } = harness;
    const documentId = await insertDocument(db, {
      title: "embeddings",
      chunks: [
        { index: 0, text: "far", embedding: axis(1) },
        { index: 1, text: "nearest", embedding: axis(0) },
      ],
    });

    const results = await models.fetchRelevantChunks(axis(0), 10, 0, 0.1);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      chunkText: "nearest",
      documentId,
      title: "embeddings",
      chunkIndex: 1,
    });
    // An exact match is similarity 1 for cosine distance.
    expect(results[0].similarity).toBeCloseTo(1, 5);
  });

  it("excludes chunks below the similarity threshold", async () => {
    const { db, models } = harness;
    await insertDocument(db, {
      chunks: [
        { index: 0, text: "identical", embedding: axis(0) },
        { index: 1, text: "orthogonal", embedding: axis(1) },
      ],
    });

    const results = await models.fetchRelevantChunks(axis(0), 10, 0, 0.5);

    expect(results.map((chunk) => chunk.chunkText)).toEqual(["identical"]);
  });

  it("skips chunks that were never embedded", async () => {
    const { db, models } = harness;
    await insertDocument(db, {
      chunks: [
        { index: 0, text: "no vector", embedding: null },
        { index: 1, text: "has vector", embedding: axis(0) },
      ],
    });

    const results = await models.fetchRelevantChunks(axis(0), 10, 0, 0.1);

    expect(results.map((chunk) => chunk.chunkText)).toEqual(["has vector"]);
  });

  it("rejects a vector of the wrong width", async () => {
    await expect(
      harness.models.fetchRelevantChunks([1, 0, 0], 10, 0, 0.1),
    ).rejects.toThrow("Expected a non-zero embedding containing 8 finite numbers");
  });

  it("rejects a vector containing a non-finite number", async () => {
    const vector = axis(0);
    vector[3] = Number.NaN;

    await expect(
      harness.models.fetchRelevantChunks(vector, 10, 0, 0.1),
    ).rejects.toThrow("Expected a non-zero embedding containing 8 finite numbers");
  });

  it("rejects an all-zero vector", async () => {
    await expect(
      harness.models.fetchRelevantChunks(axis(99), 10, 0, 0.1),
    ).rejects.toThrow("Expected a non-zero embedding containing 8 finite numbers");
  });

  it("rejects a limit outside 1..100", async () => {
    await expect(
      harness.models.fetchRelevantChunks(axis(0), 0),
    ).rejects.toThrow("Chunk limit must be an integer between 1 and 100");
    await expect(
      harness.models.fetchRelevantChunks(axis(0), 101),
    ).rejects.toThrow("Chunk limit must be an integer between 1 and 100");
    await expect(
      harness.models.fetchRelevantChunks(axis(0), 1.5),
    ).rejects.toThrow("Chunk limit must be an integer between 1 and 100");
  });

  it("honours limit and offset", async () => {
    const { db, models } = harness;
    await insertDocument(db, {
      chunks: [
        { index: 0, text: "first", embedding: axis(0) },
        { index: 1, text: "second", embedding: axis(0) },
        { index: 2, text: "third", embedding: axis(0) },
      ],
    });

    const page = await models.fetchRelevantChunks(axis(0), 1, 1, 0);

    expect(page).toHaveLength(1);
  });

  it("filters chunks by userId when provided and returns all users when omitted", async () => {
    const { db, models } = harness;
    await insertDocument(db, {
      title: "alice doc",
      userId: "alice",
      chunks: [{ index: 0, text: "alice secret", embedding: axis(0) }],
    });
    await insertDocument(db, {
      title: "bob doc",
      userId: "bob",
      chunks: [{ index: 0, text: "bob secret", embedding: axis(0) }],
    });

    const aliceOnly = await models.fetchRelevantChunks(
      axis(0),
      10,
      0,
      0.5,
      "alice",
    );
    expect(aliceOnly.map((c) => c.chunkText)).toEqual(["alice secret"]);

    const bobOnly = await models.fetchRelevantChunks(
      axis(0),
      10,
      0,
      0.5,
      "bob",
    );
    expect(bobOnly.map((c) => c.chunkText)).toEqual(["bob secret"]);

    const everyone = await models.fetchRelevantChunks(axis(0), 10, 0, 0.5);
    expect(everyone.map((c) => c.chunkText).sort()).toEqual([
      "alice secret",
      "bob secret",
    ]);
  });
});

describe("searchDbDocs", () => {
  it("embeds the query and returns the matching chunks", async () => {
    const { db, models, embedding } = harness;
    // Store exactly the vector the fake will produce for the query, so the
    // cosine distance is 0 and the hit is not a rounding accident.
    const query = "the answer";
    await insertDocument(db, {
      chunks: [
        { index: 0, text: "the answer", embedding: embeddingVector(query, DIMENSIONS) },
      ],
    });

    const results = await models.searchDbDocs({
      query,
      limit: 5,
      offset: 0,
      similarity: 0.5,
    });

    expect(embedding.inputs).toEqual([query]);
    expect(Array.isArray(results)).toBe(true);
    expect((results as { chunkText: string }[])[0].chunkText).toBe("the answer");
    expect((results as { similarity: number }[])[0].similarity).toBeCloseTo(1, 5);
  });

  it("reports a miss rather than an empty array", async () => {
    const { db } = harness;
    // A hit needs a stored vector that matches the query embedding, so index
    // nothing and ask for a near-exact match.
    expect(await db.selectFrom("document_chunks").selectAll().execute()).toEqual(
      [],
    );

    const result = await harness.models.searchDbDocs({
      query: "nothing indexed",
      limit: 5,
      offset: 0,
      similarity: 0.99,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "No available chunks found",
    });
    expect(typeof (result as { date: string }).date).toBe("string");
  });

  it("applies the default offset and similarity from the schema", async () => {
    const { searchParams } = await import("../searchDbDocs.js");

    const parsed = searchParams.parse({ query: "q", limit: "3" });

    expect(parsed).toEqual({ query: "q", limit: 3, offset: 0, similarity: 0.9 });
  });

  it("scopes searchDbDocs results when userId is provided", async () => {
    const { db, models } = harness;
    const query = "tenant specific policy";
    const vec = embeddingVector(query, DIMENSIONS);
    await insertDocument(db, {
      title: "u1",
      userId: "u-1",
      chunks: [{ index: 0, text: "u1 policy", embedding: vec }],
    });
    await insertDocument(db, {
      title: "u2",
      userId: "u-2",
      chunks: [{ index: 0, text: "u2 policy", embedding: vec }],
    });

    const u1Results = await models.searchDbDocs(
      { query, limit: 5, offset: 0, similarity: 0.5 },
      "u-1",
    );
    expect(Array.isArray(u1Results)).toBe(true);
    expect((u1Results as { chunkText: string }[]).map((r) => r.chunkText)).toEqual([
      "u1 policy",
    ]);

    const u3Miss = await models.searchDbDocs(
      { query, limit: 5, offset: 0, similarity: 0.5 },
      "u-3",
    );
    expect(u3Miss).toMatchObject({
      ok: false,
      reason: "No available chunks found",
    });
  });
});

describe("readToolDocument", () => {
  it("returns the whole document when no chunk range is asked for", async () => {
    const { db, models } = harness;
    const documentId = await insertDocument(db, {
      title: "a title",
      rawContent: "the body",
      chunks: [{ index: 0, text: "the body", embedding: axis(0) }],
    });

    const result = await models.readToolDocument("u-1", { documentId });

    expect(result).toMatchObject({
      id: documentId,
      title: "a title",
      content: "the body",
      truncated: false,
      chunkCount: 1,
      // Chunks exist, so the caller is told where to start reading them.
      nextChunkStart: 0,
    });
  });

  it("reports null nextChunkStart for a document without chunks", async () => {
    const { db, models } = harness;
    const documentId = await insertDocument(db, { rawContent: "no chunks" });

    const result = await models.readToolDocument("u-1", { documentId });

    expect(result).toMatchObject({ chunkCount: 0, nextChunkStart: null });
  });

  it("refuses a document owned by somebody else", async () => {
    const { db, models } = harness;
    const documentId = await insertDocument(db, {
      userId: "u-2",
      rawContent: "secret",
    });

    expect(await models.readToolDocument("u-1", { documentId })).toBeNull();
  });

  it("refuses a document that does not exist", async () => {
    expect(await harness.models.readToolDocument("u-1", { documentId: 4_242 })).toBeNull();
  });

  it("flags a body past the inline ceiling as truncated", async () => {
    const { db, models } = harness;
    // The default ceiling is MAX_DOC_TOKENS(3000) * 4 chars * 2 = 24000 chars.
    const documentId = await insertDocument(db, { rawContent: "y".repeat(30_000) });

    const result = await models.readToolDocument("u-1", { documentId });

    expect(result).toMatchObject({ truncated: true /* isLargeFile */ });
    // Two caps apply in sequence: SQL `substr` reads at most
    // MAX_DOC_TOKENS * CHARS_PER_TOKEN * 2 = 24 000 chars, then the truncate
    // pass cuts that to MAX_DOC_TOKENS * CHARS_PER_TOKEN = 12 000.
    expect((result as { content: string }).content).toHaveLength(12_000);
  });

  it("honours a custom token ceiling", async () => {
    const { db, models } = harness;
    const documentId = await insertDocument(db, { rawContent: "y".repeat(200) });

    // 5 tokens * 4 chars * 2 = 40 chars inline, and 5*4 = 20 after truncation.
    const result = await models.readToolDocument("u-1", { documentId }, 4, 5);

    expect((result as { content: string }).content).toHaveLength(20);
    expect(result).toMatchObject({ truncated: true });
  });

  it("returns the requested chunk range", async () => {
    const { db, models } = harness;
    const documentId = await insertDocument(db, {
      chunks: [
        { index: 0, text: "chunk zero", embedding: axis(0) },
        { index: 1, text: "chunk one", embedding: axis(0) },
        { index: 2, text: "chunk two", embedding: axis(0) },
      ],
    });

    const result = await models.readToolDocument("u-1", {
      documentId,
      chunkStart: 0,
      chunkEnd: 1,
    });

    expect(result).toMatchObject({
      chunkCount: 3,
      chunkStart: 0,
      chunkEnd: 1,
      nextChunkStart: 2,
    });
    expect(
      (result as { chunks: { content: string }[] }).chunks.map((c) => c.content),
    ).toEqual(["chunk zero", "chunk one"]);
  });

  it("reports no nextChunkStart once the last chunk was read", async () => {
    const { db, models } = harness;
    const documentId = await insertDocument(db, {
      chunks: [
        { index: 0, text: "only", embedding: axis(0) },
      ],
    });

    const result = await models.readToolDocument("u-1", {
      documentId,
      chunkStart: 0,
      chunkEnd: 0,
    });

    expect(result).toMatchObject({ nextChunkStart: null });
  });

  it("caps the chunks returned by one read", async () => {
    const { db, models } = harness;
    const documentId = await insertDocument(db, {
      chunks: Array.from({ length: 15 }, (_, index) => ({
        index,
        text: `chunk ${String(index)}`,
        embedding: axis(0),
      })),
    });

    const result = await models.readToolDocument("u-1", {
      documentId,
      chunkStart: 0,
      chunkEnd: 14,
    });

    // The tool schema promises at most 10 chunks per read.
    expect((result as { chunks: unknown[] }).chunks).toHaveLength(10);
    expect(result).toMatchObject({ nextChunkStart: 10 });
  });

  it("truncates a single oversized chunk", async () => {
    const { db, models } = harness;
    const documentId = await insertDocument(db, {
      chunks: [
        { index: 0, text: "z".repeat(9_000), embedding: axis(0) },
      ],
    });

    const result = await models.readToolDocument(
      "u-1",
      { documentId, chunkStart: 0, chunkEnd: 0 },
      4,
      3_000,
      100,
    );

    const [chunk] = (result as { chunks: { content: string; truncated: boolean }[] })
      .chunks;
    expect(chunk.truncated).toBe(true);
    expect(chunk.content).toHaveLength(400);
  });

  it("requires chunkEnd when chunkStart is supplied", async () => {
    const { db, models } = harness;
    const documentId = await insertDocument(db, { rawContent: "body" });

    await expect(
      models.readToolDocument("u-1", { documentId, chunkStart: 0 }),
    ).rejects.toThrow("chunkEnd is required when chunkStart is supplied");
  });

  it("truncates an over-long title to the 100-token ceiling", async () => {
    const { db, models } = harness;
    const documentId = await insertDocument(db, { title: "t".repeat(500) });

    const result = await models.readToolDocument("u-1", { documentId });

    expect((result as { title: string }).title).toHaveLength(400);
  });
});

describe("saveUploadedScrappedFile", () => {
  it("ingests a plain text file as a document plus chunks", async () => {
    const { db, models } = harness;

    const results = await models.saveUploadedScrappedFile(
      [{ name: "notes.md", data: "# Heading\n\nSome body text." }],
      "u-1",
    );

    expect(results).toEqual({
      ingested: ["notes.md"],
      skippedDuplicates: [],
      errors: [],
    });
    const document = await db
      .selectFrom("documents")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(document.title).toBe("notes.md");
    expect(document.user_id).toBe("u-1");
    const chunks = await db.selectFrom("document_chunks").selectAll().execute();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].document_id).toBe(document.id);
  });

  it("skips a duplicate body even under a different filename", async () => {
    const { db, models } = harness;
    const body = "identical content";

    const first = await models.saveUploadedScrappedFile(
      [{ name: "one.md", data: body }],
      "u-1",
    );
    const second = await models.saveUploadedScrappedFile(
      [{ name: "two.md", data: body }],
      "u-1",
    );

    expect(first.ingested).toEqual(["one.md"]);
    expect(second).toEqual({
      ingested: [],
      skippedDuplicates: ["two.md"],
      errors: [],
    });
    expect(await db.selectFrom("documents").selectAll().execute()).toHaveLength(1);
  });

  it("reports an unsupported extension without touching the database", async () => {
    const { db, models } = harness;

    const results = await models.saveUploadedScrappedFile(
      [{ name: "script.exe", data: "binary" }],
      "u-1",
    );

    expect(results.errors).toEqual(["Skipped script.exe: Unsupported file type"]);
    expect(await db.selectFrom("documents").selectAll().execute()).toEqual([]);
  });

  it("honours a custom extension list", async () => {
    const { models } = harness;

    const results = await models.saveUploadedScrappedFile(
      [{ name: "data.csv", data: "a,b\n1,2" }],
      "u-1",
      { extensions: [".csv"] },
    );

    expect(results.ingested).toEqual(["data.csv"]);
  });

  it("keeps going when one file fails", async () => {
    const { models } = harness;

    const results = await models.saveUploadedScrappedFile(
      [
        // A formatter that throws makes this file fail on its own.
        {
          name: "boom.md",
          data: "content",
        },
        { name: "fine.md", data: "other content" },
      ],
      "u-1",
      {
        prepare: {
          formatter: (_title: string, raw: string) => {
            if (raw === "content") throw new Error("formatter exploded");
            return raw;
          },
        },
      },
    );

    expect(results.errors).toEqual(["Failed boom.md"]);
    expect(results.ingested).toEqual(["fine.md"]);
  });

  it("accepts a Buffer source and an omitted user id", async () => {
    const { db, models } = harness;

    const results = await models.saveUploadedScrappedFile(
      [{ name: "buffer.txt", data: Buffer.from("from a buffer", "utf-8") }],
      undefined,
    );

    expect(results.ingested).toEqual(["buffer.txt"]);
    const document = await db
      .selectFrom("documents")
      .select("user_id")
      .executeTakeFirstOrThrow();
    expect(document.user_id).toBeNull();
  });

  it("accepts a Uint8Array source", async () => {
    const { models } = harness;

    const results = await models.saveUploadedScrappedFile(
      [
        {
          name: "bytes.txt",
          data: new Uint8Array(Buffer.from("raw bytes", "utf-8")),
        },
      ],
      "u-1",
    );

    expect(results.ingested).toEqual(["bytes.txt"]);
  });

  it("reads files out of a FormData upload", async () => {
    const { models } = harness;
    const form = new FormData();
    form.append("file", new Blob(["from a form"]), "form.txt");

    const results = await models.saveUploadedScrappedFile(form, "u-1");

    expect(results.ingested).toEqual(["form.txt"]);
  });

  it("ignores string entries in a FormData", async () => {
    const { models } = harness;
    const form = new FormData();
    form.append("caption", "a plain field");
    form.append("file", new Blob(["real file"]), "real.txt");

    const results = await models.saveUploadedScrappedFile(form, "u-1");

    expect(results.ingested).toEqual(["real.txt"]);
  });

  it("applies a custom batched insert size", async () => {
    const { db, models } = harness;

    const results = await models.saveUploadedScrappedFile(
      [{ name: "batched.md", data: "x".repeat(50_000) }],
      "u-1",
      { batchSize: 2, prepare: { maxTokens: 100, overlapTokens: 10 } },
    );

    expect(results.ingested).toEqual(["batched.md"]);
    const chunks = await db.selectFrom("document_chunks").selectAll().execute();
    expect(chunks.length).toBeGreaterThan(2);
  });

  it("stores the embedding for every chunk", async () => {
    const { db, models } = harness;

    await models.saveUploadedScrappedFile(
      [{ name: "embedded.md", data: "some text to embed" }],
      "u-1",
    );

    const chunks = await db.selectFrom("document_chunks").selectAll().execute();
    for (const chunk of chunks) {
      expect(chunk.embedding).not.toBeNull();
    }
  });

  it("records chunk metadata from the prepare formatter", async () => {
    const { db, models } = harness;

    await models.saveUploadedScrappedFile(
      [{ name: "formatted.md", data: "raw body" }],
      "u-1",
      {
        jsonData: { source: "https://example.com" },
        prepare: {
          formatter: (title: string, raw: string, json: { source: string }) =>
            `${title} from ${json.source}: ${raw}`,
        },
      },
    );

    const document = await db
      .selectFrom("documents")
      .select("raw_content")
      .executeTakeFirstOrThrow();
    expect(document.raw_content).toBe(
      "formatted.md from https://example.com: raw body",
    );
  });
});
