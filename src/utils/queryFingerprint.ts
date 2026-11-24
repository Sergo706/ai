const NOISE_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "and",
  "with",
  "in",
  "on",
  "to",
  "this",
  "that",
]);

/**
 * Reduce a query to a stable, comparison-friendly fingerprint.
 *
 * Lowercases, drops years and punctuation, removes common stop words, then
 * sorts the remaining tokens, so word order and casing no longer matter.
 *
 * @param query - The user query.
 * @returns The normalised fingerprint; the same text always maps to the same
 * string.
 * @example
 * ```ts
 * fingerprintQuery("Best Laptops for 2024?"); // "best laptops"
 * ```
 */
export function fingerprintQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !NOISE_WORDS.has(token))
    .sort()
    .join(" ");
}
