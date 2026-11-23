import { chunkProcess } from "@riavzon/utils";
import { PreparedChunk } from "../types/PrepareScrape";
import { calculateCosineSimilarity } from "../utils/vectorMath";
import { generateMatchingEmbedding } from "./embedding";


export interface AdaptiveFilterConfig<C> {
  candidateLimit: number,
  minCoverage: number,
  duplicateThreshold: number,
  embeddingConcurrency: number,
  byPassAuthorityDedupe?: (incomingChunks: PreparedChunk<C>) => boolean;
}

export interface AcceptedAdaptiveChunk<C> extends PreparedChunk<C> {
  coverageScore: number;
}

export interface AdaptiveFilterResult<C> {
  acceptedChunks: AcceptedAdaptiveChunk<C>[];
  newMatchingVectors: number[][];
  acceptedByAuthority: number;
  rejectedAsDuplicate: number;
}

export async function filterAdaptiveChunks<C>(
  queryVector: number[],
  incomingChunks: PreparedChunk<C>[],
  accumulatedMatchingVectors: number[][],
  config: AdaptiveFilterConfig<C>
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
