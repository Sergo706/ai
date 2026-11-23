import { sql } from "kysely";
import { getConfiguration, getDb } from "../config/config";
import { getDistance } from "../db/utils";

export interface RelevantChunk {
  id: number;
  documentId: number | null;
  chunkIndex: number;
  chunkText: string;
  title: string | null;
  retrievedAt: Date | string;
  similarity: number;
}

/**
 * Nearest chunks to `queryVector`, most similar first.
 */
export async function fetchRelevantChunks(
  queryVector: number[],
  limit = 10,
  offset = 0,
  similarityThreshold = 0.1,
): Promise<RelevantChunk[]> {
  const { dimensions } = getConfiguration().embeddingConfig;

  if (
    queryVector.length !== dimensions ||
    queryVector.some((value) => !Number.isFinite(value)) ||
    queryVector.every((value) => value === 0)
  ) {
    throw new Error(
      `Expected a non-zero embedding containing ${String(dimensions)} finite numbers`,
    );
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Chunk limit must be an integer between 1 and 100");
  }

  const distance = getDistance(queryVector);
  const similarity = sql<number>`1 - (${distance})`;

  return getDb()
    .selectFrom("document_chunks as c")
    .innerJoin("documents as d", "d.id", "c.document_id")
    .select([
      "c.id as id",
      "c.document_id as documentId",
      "c.chunk_index as chunkIndex",
      "c.chunk_text as chunkText",
      "d.title as title",
      "d.created_at as retrievedAt",
    ])
    .select(similarity.as("similarity"))
    .where(sql<boolean>`1 - (${distance}) > ${similarityThreshold}`)
    .where("c.embedding", "is not", null)
    .orderBy(distance, "asc")
    .limit(limit)
    .offset(offset)
    .execute();
}
