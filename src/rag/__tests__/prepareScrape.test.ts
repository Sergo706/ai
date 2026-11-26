import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type OpenAI from "openai";

import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";
import { libLogger } from "~~/test/test-utils/logger";
import {
  embeddingFake,
  embeddingVector,
  installEmbeddingFake,
  offlineClient,
} from "~~/test/test-utils/streamLlm";

/**
 * Scrape preparation: chunking a document and embedding every chunk.
 *
 * The chunk index is the durable key a host stores next to the vector, so it
 * has to be dense and ascending no matter how the embedding batches happen to
 * complete; and a vector the pipeline refuses to validate must fail the whole
 * scrape rather than land in the store.
 */

type PrepareScrape = typeof import("~/rag/prepareScrape.js");

const DIMENSIONS = 8;

interface Harness {
  env: LoadedConfig;
  fake: ReturnType<typeof embeddingFake>;
  prepareScrape: PrepareScrape["prepareScrape"];
}

let harness: Harness;

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

  return {
    env,
    fake,
    prepareScrape: (await import("~/rag/prepareScrape.js")).prepareScrape,
  };
}

beforeAll(async () => {
  harness = await boot();
});

afterAll(async () => {
  await harness.env.cleanup();
});

beforeEach(() => {
  harness.fake.inputs.length = 0;
});

describe("prepareScrape", () => {
  it("carries the title, the raw markdown and the json through untouched", async () => {
    const jsonData = { author: "someone", tags: ["a"] };

    const result = await harness.prepareScrape(
      "A title",
      "some raw markdown",
      jsonData,
    );

    expect(result.title).toBe("A title");
    expect(result.fullContent).toBe("some raw markdown");
    expect(result.jsonData).toBe(jsonData);
  });

  it("chunks the formatter's output rather than the raw markdown", async () => {
    const result = await harness.prepareScrape(
      "Title",
      "raw",
      { id: 7 },
      {
        formatter: (title, rawText, json: { id: number }) =>
          `${title}\n${rawText}\nid=${json.id.toString()}`,
      },
    );

    expect(result.fullContent).toBe("Title\nraw\nid=7");
    expect(result.chunks.map((chunk) => chunk.chunkText)).toEqual([
      "Title\nraw\nid=7",
    ]);
  });

  it("produces no chunks and embeds nothing for blank markdown", async () => {
    const result = await harness.prepareScrape("Empty", "   \n\t  ", {});

    expect(result.chunks).toEqual([]);
    expect(harness.fake.inputs).toEqual([]);
  });

  it("numbers the chunks densely in order and embeds each exactly once", async () => {
    const body = Array.from(
      { length: 12 },
      (_, i) => `paragraph ${i.toString()}.`,
    ).join("\n\n");

    const result = await harness.prepareScrape(
      "Long",
      body,
      {},
      {
        maxTokens: 20,
        overlapTokens: 0,
        charsPerTokenEstimate: 4,
        embeddingConcurrency: 1,
      },
    );

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      result.chunks.map((_chunk, index) => index),
    );
    // One embedding call per chunk, in chunk order.
    expect(harness.fake.inputs).toEqual(
      result.chunks.map((chunk) => chunk.chunkText),
    );
  });

  it("returns embeddings at the configured width", async () => {
    const result = await harness.prepareScrape("Width", "hello world", {});

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].embedding).toEqual(
      embeddingVector("hello world", DIMENSIONS),
    );
  });

  it("labels each chunk with chunkMeta's return value", async () => {
    const body = "first block of text\n\nsecond block of text";

    const result = await harness.prepareScrape(
      "Meta",
      body,
      { source: "https://a.com" },
      {
        maxTokens: 10,
        overlapTokens: 0,
        embeddingConcurrency: 1,
        chunkMeta: (chunkText, chunkIndex) => ({
          chunkIndex,
          length: chunkText.length,
        }),
      },
    );

    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(chunk.customFields).toEqual({
        chunkIndex: chunk.chunkIndex,
        length: chunk.chunkText.length,
      });
    }
  });

  it("omits customFields when no chunkMeta is supplied", async () => {
    const result = await harness.prepareScrape("Plain", "hello", {});

    expect(result.chunks).toHaveLength(1);
    expect("customFields" in result.chunks[0]).toBe(false);
  });

  it("fails the scrape when the provider returns an all-zero vector", async () => {
    // A zero vector has no direction, so every later similarity comparison
    // would read it as unrelated; the pipeline must refuse it up front.
    const client: OpenAI = offlineClient();
    installEmbeddingFake(client, {
      client: {
        embeddings: {
          create: vi.fn((body: { model: string }) =>
            Promise.resolve({
              object: "list",
              model: body.model,
              data: [
                {
                  object: "embedding",
                  index: 0,
                  embedding: new Array<number>(DIMENSIONS).fill(0),
                },
              ],
              usage: { prompt_tokens: 1, total_tokens: 1 },
            }),
          ),
        },
      },
      inputs: [],
    });

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

    try {
      const mod: PrepareScrape = await import("~/rag/prepareScrape.js");
      await expect(mod.prepareScrape("Zero", "some text", {})).rejects.toThrow(
        `Expected a non-zero embedding containing ${DIMENSIONS.toString()} finite numbers`,
      );
    } finally {
      await env.cleanup();
    }
  });
});
