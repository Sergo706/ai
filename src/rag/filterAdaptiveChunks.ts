import { chunkProcess } from "@riavzon/utils";
import { PreparedChunk } from "../types/PrepareScrape";
import { calculateCosineSimilarity } from "../utils/vectorMath";
import { generateMatchingEmbedding } from "./embedding";

/** Tuning for {@link filterAdaptiveChunks}. */
export interface AdaptiveFilterConfig<C> {
  /** Chunks kept for de-duplication after the coverage filter. */
  candidateLimit: number;
  /** Minimum cosine similarity to the query for a chunk to be considered. */
  minCoverage: number;
  /** Similarity above which a chunk counts as a duplicate of a known one. */
  duplicateThreshold: number;
  /** Matching-embedding batches run in parallel. */
  embeddingConcurrency: number;
  /**
   * Keep an otherwise-duplicate chunk anyway.
   *
   * @returns `true` to accept the chunk despite the similarity.
   */
  byPassAuthorityDedupe?: (incomingChunks: PreparedChunk<C>) => boolean;
}

/** A chunk that survived filtering, with the score that admitted it. */
export interface AcceptedAdaptiveChunk<C> extends PreparedChunk<C> {
  /** Cosine similarity between this chunk and the query. */
  coverageScore: number;
}

/** What {@link filterAdaptiveChunks} accepted, and the counts it rejected. */
export interface AdaptiveFilterResult<C> {
  /** Chunks worth adding to the document, most relevant first. */
  acceptedChunks: AcceptedAdaptiveChunk<C>[];
  /** Matching vectors of the accepted chunks, ready to persist. */
  newMatchingVectors: number[][];
  /** How many chunks were kept only because dedupe was bypassed. */
  acceptedByAuthority: number;
  /** How many chunks were dropped as duplicates. */
  rejectedAsDuplicate: number;
}

/**
 * Narrow incoming chunks to the ones worth adding to a document.
 *
 * Scores every chunk against the query, drops the ones below `minCoverage`,
 * then de-duplicates the survivors by comparing them to the vectors already
 * stored. Only the accepted chunks' vectors come back, so a caller only pays to
 * embed what it keeps.
 *
 * @param queryVector - Embedding of the user's query.
 * @param incomingChunks - Freshly prepared chunks to consider.
 * @param accumulatedMatchingVectors - Vectors already stored for this document.
 * @param config - Coverage, limit and de-duplication thresholds.
 * @returns The accepted chunks plus the vectors that should be persisted.
 */
export async function filterAdaptiveChunks<C>(
  queryVector: number[],
  incomingChunks: PreparedChunk<C>[],
  accumulatedMatchingVectors: number[][],
  config: AdaptiveFilterConfig<C>,
): Promise<AdaptiveFilterResult<C>> {
  const acceptedChunks: AcceptedAdaptiveChunk<C>[] = [];
  const newMatchingVectors: number[][] = [];

  if (incomingChunks.length === 0) {
    return {
      acceptedChunks,
      newMatchingVectors,
      acceptedByAuthority: 0,
      rejectedAsDuplicate: 0,
    };
  }

  const scoredChunks = incomingChunks.map((chunk) => ({
    ...chunk,
    coverageScore: calculateCosineSimilarity(queryVector, chunk.embedding),
  }));

  scoredChunks.sort((a, b) => b.coverageScore - a.coverageScore);

  const candidateChunks = scoredChunks
    .filter((c) => c.coverageScore >= config.minCoverage)
    .slice(0, config.candidateLimit);

  const matchingVectors: number[][] = new Array<number[]>(
    candidateChunks.length,
  );

  await chunkProcess(
    candidateChunks.map((_chunk, index) => index),
    config.embeddingConcurrency,
    async (indexBatch) => {
      await Promise.all(
        indexBatch.map(async (index) => {
          matchingVectors[index] = await generateMatchingEmbedding(
            candidateChunks[index].chunkText,
          );
        }),
      );
    },
  );

  let acceptedByAuthority = 0;
  let rejectedAsDuplicate = 0;

  for (const [index, chunk] of candidateChunks.entries()) {
    const matchingVector = matchingVectors[index];
    const knownVectors = [...accumulatedMatchingVectors, ...newMatchingVectors];

    const isDuplicate = knownVectors.some((existingVector) => {
      return (
        calculateCosineSimilarity(matchingVector, existingVector) >
        config.duplicateThreshold
      );
    });

    let bypassDedupe = false;

    if (config.byPassAuthorityDedupe) {
      bypassDedupe = config.byPassAuthorityDedupe(chunk);
    }

    if (isDuplicate && !bypassDedupe) {
      rejectedAsDuplicate++;
      continue;
    }

    if (isDuplicate) acceptedByAuthority++;

    newMatchingVectors.push(matchingVector);
    acceptedChunks.push(chunk);
  }
  return {
    acceptedChunks,
    newMatchingVectors,
    acceptedByAuthority,
    rejectedAsDuplicate,
  };
}
