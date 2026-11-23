import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type OpenAI from "openai";

import type { PreparedChunk } from "~/types/PrepareScrape.js";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";
import { libLogger } from "~~/test/test-utils/logger";
import {
  embeddingFake,
  installEmbeddingFake,
  offlineClient,
} from "~~/test/test-utils/streamLlm";

/**
 * The adaptive chunk filter: coverage ranking, the duplicate gate and the
 * authority bypass.
 *
 * These run against the real configured embedding transport (a deterministic
 * fake behind the real client), so the matching vectors are produced by the
 * same code path production uses rather than by a hand-written stub.
 */

type Filter = typeof import("~/rag/filterAdaptiveChunks.js");

const DIMENSIONS = 8;

interface Harness {
  env: LoadedConfig;
  fake: ReturnType<typeof embeddingFake>;
  filterAdaptiveChunks: Filter["filterAdaptiveChunks"];
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
    filterAdaptiveChunks: (await import("~/rag/filterAdaptiveChunks.js"))
      .filterAdaptiveChunks,
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

/** The lazily-imported filter, which needs the booted configuration. */
function harnessFilter<C>(
  ...args: Parameters<
    typeof import("~/rag/filterAdaptiveChunks.js").filterAdaptiveChunks<C>
  >
): ReturnType<typeof import("~/rag/filterAdaptiveChunks.js").filterAdaptiveChunks<C>> {
  return harness.filterAdaptiveChunks<C>(...args);
}

describe("filterAdaptiveChunks", () => {
  const config = {
    candidateLimit: 10,
    minCoverage: 0,
    duplicateThreshold: 0.9,
    embeddingConcurrency: 2,
  };

  function chunk(
    index: number,
    text: string,
    embedding: number[],
  ): PreparedChunk {
    return { chunkIndex: index, chunkText: text, embedding };
  }

  it("returns empty results for no incoming chunks", async () => {
    const result = await harnessFilter([1, 0, 0, 0, 0, 0, 0, 0], [], [], config);

    expect(result).toEqual({
      acceptedChunks: [],
      newMatchingVectors: [],
      acceptedByAuthority: 0,
      rejectedAsDuplicate: 0,
    });
  });

  it("scores chunks by coverage and keeps the best ones", async () => {
    const query = [1, 0, 0, 0, 0, 0, 0, 0];
    const chunks = [
      chunk(0, "orthogonal", [0, 1, 0, 0, 0, 0, 0, 0]),
      chunk(1, "identical", [1, 0, 0, 0, 0, 0, 0, 0]),
    ];

    const result = await harnessFilter(query, chunks, [], {
      ...config,
      candidateLimit: 1,
    });

    expect(result.acceptedChunks).toHaveLength(1);
    expect(result.acceptedChunks[0].chunkText).toBe("identical");
    expect(result.acceptedChunks[0].coverageScore).toBeCloseTo(1, 10);
  });

  it("drops chunks below minCoverage", async () => {
    const query = [1, 0, 0, 0, 0, 0, 0, 0];

    const result = await harnessFilter(
      query,
      [chunk(0, "orthogonal", [0, 1, 0, 0, 0, 0, 0, 0])],
      [],
      { ...config, minCoverage: 0.5 },
    );

    expect(result.acceptedChunks).toEqual([]);
  });

  it("rejects a chunk whose matching vector duplicates a known one", async () => {
    const query = [1, 0, 0, 0, 0, 0, 0, 0];
    // The fake embeds deterministically, so embedding the same text twice
    // produces the same vector and the second chunk is a duplicate.
    const first = await harnessFilter(
      query,
      [chunk(0, "same text", [1, 0, 0, 0, 0, 0, 0, 0])],
      [],
      config,
    );

    expect(first.acceptedChunks).toHaveLength(1);

    const second = await harnessFilter(
      query,
      [chunk(0, "same text", [1, 0, 0, 0, 0, 0, 0, 0])],
      first.newMatchingVectors,
      config,
    );

    expect(second.acceptedChunks).toEqual([]);
    expect(second.rejectedAsDuplicate).toBe(1);
    expect(second.acceptedByAuthority).toBe(0);
  });

  it("accepts a duplicate when the authority check bypasses dedupe", async () => {
    const query = [1, 0, 0, 0, 0, 0, 0, 0];
    const known = await harnessFilter(
      query,
      [chunk(0, "same text", [1, 0, 0, 0, 0, 0, 0, 0])],
      [],
      config,
    );

    const result = await harnessFilter(
      query,
      [chunk(0, "same text", [1, 0, 0, 0, 0, 0, 0, 0])],
      known.newMatchingVectors,
      { ...config, byPassAuthorityDedupe: () => true },
    );

    expect(result.acceptedChunks).toHaveLength(1);
    expect(result.acceptedByAuthority).toBe(1);
    expect(result.rejectedAsDuplicate).toBe(0);
  });

  it("counts a non-duplicate as a plain acceptance, not an authority one", async () => {
    const query = [1, 0, 0, 0, 0, 0, 0, 0];

    const result = await harnessFilter(
      query,
      [chunk(0, "unique text", [1, 0, 0, 0, 0, 0, 0, 0])],
      [],
      { ...config, byPassAuthorityDedupe: () => false },
    );

    expect(result.acceptedChunks).toHaveLength(1);
    expect(result.acceptedByAuthority).toBe(0);
  });

  it("embeds every candidate once", async () => {
    const query = [1, 0, 0, 0, 0, 0, 0, 0];

    const result = await harnessFilter(
      query,
      [
        chunk(0, "text one", [1, 0, 0, 0, 0, 0, 0, 0]),
        chunk(1, "text two", [1, 0, 0, 0, 0, 0, 0, 0]),
      ],
      [],
      config,
    );

    expect(harness.fake.inputs).toEqual(["text one", "text two"]);
    // Both candidates were embedded, but their matching vectors are identical
    // (the fake is deterministic), so the second is a duplicate and only one
    // vector is kept.
    expect(harness.fake.inputs).toHaveLength(2);
    expect(result.newMatchingVectors).toHaveLength(1);
    expect(result.rejectedAsDuplicate).toBe(1);
  });
});
