import { generateEmbedding } from "../rag/embedding";
import { fetchRelevantChunks } from "./getRelevantChunks";

import z from "zod";

/** Validation for {@link searchDbDocs} arguments. */
export const searchParams = z.object({
  query: z.string().max(500),
  limit: z.coerce.number(),
  offset: z.coerce.number().default(0),
  similarity: z.coerce.number().default(0.9),
});

/** The parsed arguments of {@link searchDbDocs}. */
export type SearchDbParams = z.infer<typeof searchParams>;

/**
 * Search stored documents for chunks near a query.
 *
 * Embeds the query with the retrieval model, then returns the nearest chunks.
 *
 * @param conf - Query text, page size, offset and minimum similarity.
 * @returns The matching chunks, or `ok: false` with a reason when none matched.
 * @example
 * ```ts
 * const hits = await searchDbDocs({ query: "pricing", limit: 5, offset: 0, similarity: 0.8 });
 * ```
 */
export async function searchDbDocs(conf: SearchDbParams, userId?: string) {
  const { query, limit, offset, similarity } = conf;
  const embedding = await generateEmbedding(query);

  const res = await fetchRelevantChunks(
    embedding,
    limit,
    offset,
    similarity,
    userId,
  );
  if (res.length === 0) {
    return {
      ok: false,
      date: new Date().toISOString(),
      reason: "No available chunks found",
    };
  }
  return res;
}
