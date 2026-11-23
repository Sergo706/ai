import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
 * The two embedding entry points and the width contract they enforce.
 *
 * Retrieval embeds documents with one model and queries with another, so the
 * helpers differ only in which model they name — but both must reject a vector
 * whose width disagrees with `embeddingConfig.dimensions`, because a mismatch
 * stored silently would poison every later similarity comparison.
 */

type Embedding = typeof import("~/rag/embedding.js");

const DIMENSIONS = 8;

interface Harness {
  env: LoadedConfig;
  fake: ReturnType<typeof embeddingFake>;
  embedding: Embedding;
}

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

  return { env, fake, embedding: await import("~/rag/embedding.js") };
}

let harness: Harness;

beforeAll(async () => {
  harness = await boot();
});

afterAll(async () => {
  await harness.env.cleanup();
});

describe("generateEmbedding", () => {
  it("uses the retrieval model and returns the vector", async () => {
    const { embedding, fake } = harness;

    const vector = await embedding.generateEmbedding("hello");

    expect(fake.inputs).toEqual(["hello"]);
    expect(vector).toHaveLength(DIMENSIONS);
    expect(vector).toEqual(embeddingVector("hello", DIMENSIONS));
  });

  it("throws when the provider returns a different width", async () => {
    // The transport answers with 16 values while the config claims 8, so the
    // guard — not the fake — is what has to fail the call.
    const client: OpenAI = offlineClient();
    installEmbeddingFake(client, embeddingFake(16));

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
      const mod: Embedding = await import("~/rag/embedding.js");
      await expect(mod.generateEmbedding("wide")).rejects.toThrow(
        "The configured dimensions is not equal to what the embedding model returned. Use 16 in embeddingConfig.dimensions or a different model",
      );
    } finally {
      await env.cleanup();
    }
  });
});

describe("generateMatchingEmbedding", () => {
  it("uses the matching model rather than the retrieval one", async () => {
    const { embedding, fake } = harness;

    await embedding.generateMatchingEmbedding("a query");

    expect(fake.inputs).toEqual(["a query"]);
    // The vector comes back at the configured width, so a caller can rely on it
    // without re-checking; the mismatch case below is what enforces that.
    expect(await embedding.generateMatchingEmbedding("a query")).toHaveLength(
      DIMENSIONS,
    );
  });

  it("throws on a width mismatch", async () => {
    const client: OpenAI = offlineClient();
    installEmbeddingFake(client, embeddingFake(16));

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
      const mod: Embedding = await import("~/rag/embedding.js");
      await expect(mod.generateMatchingEmbedding("wide")).rejects.toThrow(
        "The configured dimensions is not equal to what the embedding model returned",
      );
    } finally {
      await env.cleanup();
    }
  });
});
