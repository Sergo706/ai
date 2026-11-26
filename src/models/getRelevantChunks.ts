import { sql } from "kysely";
import { getConfiguration, getDb } from "../config/config";
import { getDistance } from "../db/utils";

/** A document chunk returned by {@link fetchRelevantChunks}. */
export interface RelevantChunk {
  /** Chunk row id. */
  id: number;
  /** Document the chunk belongs to, if any. */
  documentId: number | null;
  /** Position of the chunk within its document. */
  chunkIndex: number;
  /** The chunk text. */
  chunkText: string;
  /** Title of the owning document. */
  title: string | null;
  /** When the chunk was stored. */
  retrievedAt: Date | string;
  /** Cosine similarity to the query, from 0 to 1. */
  similarity: number;
}

/**
 * Find the document chunks nearest to a query vector.
 *
 * @param queryVector - Embedding to compare against, e.g. from
 * `generateMatchingEmbedding`.
 * @param limit - Maximum chunks to return.
 * @default limit 10
 * @param offset - Rows to skip, for paging.
 * @default offset 0
 * @param similarityThreshold - Minimum similarity to include.
 * @default similarityThreshold 0.1
 * @returns Matching chunks, most similar first.
 */
export async function fetchRelevantChunks(
  queryVector: number[],
  limit = 10,
  offset = 0,
  similarityThreshold = 0.1,
  userId?: string,
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

  let query = getDb()
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
    .where("c.embedding", "is not", null);

  if (userId) {
    query = query.where("d.user_id", "=", userId);
  }

  return query.orderBy(distance, "asc").limit(limit).offset(offset).execute();
}
