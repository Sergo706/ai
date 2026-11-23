import { generateEmbedding } from "../rag/embedding";
import { fetchRelevantChunks } from "./getRelevantChunks";

import z from "zod";

export const searchParams = z.object({
  query: z.string().max(500),
  limit: z.coerce.number(),
  offset: z.coerce.number().default(0),
  similarity: z.coerce.number().default(0.9),
});

export type SearchDbParams = z.infer<typeof searchParams>;

export async function searchDbDocs(conf: SearchDbParams) {
  const { query, limit, offset, similarity } = conf;
  const embedding = await generateEmbedding(query);

  const res = await fetchRelevantChunks(embedding, limit, offset, similarity);
    if (res.length === 0) {
      return {
        ok: false,
        date: new Date().toISOString(),
        reason: "No available chunks found",
      };
    }
    return res;
}
