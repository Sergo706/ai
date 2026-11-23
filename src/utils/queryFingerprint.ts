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
