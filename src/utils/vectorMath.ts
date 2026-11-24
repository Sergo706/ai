/**
 * Cosine similarity between two vectors.
 *
 * @param vecA - First vector.
 * @param vecB - Second vector of the same length.
 * @returns A score from `-1` to `1`, or `0` when the lengths differ or either
 * vector is all zeros.
 * @example
 * ```ts
 * const score = calculateCosineSimilarity(queryVec, chunkVec);
 * ```
 */
export function calculateCosineSimilarity(
  vecA: number[],
  vecB: number[],
): number {
  if (vecA.length !== vecB.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
