import { sql } from "kysely";
import type z from "zod";
import { getDb } from "../config/config";
import { documentParams } from "../tools/common-tools-handlers/schemas";
import { envInt } from "@riavzon/utils/server";

function truncateToTokens(
  text: string | null,
  maxTokens: number,
  CHARS_PER_TOKEN = 4,
): { text: string; truncated: boolean } {
  if (!text) return { text: "", truncated: false };

  const limit = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= limit) return { text, truncated: false };

  return { text: text.slice(0, limit).trimEnd(), truncated: true };
}

/**
 * Read one stored document for the model, truncated to a token budget.
 *
 * @param userId - Owner, checked before returning anything.
 * @param args - Which document to read.
 * @param CHARS_PER_TOKEN - Fallback characters-per-token estimate.
 * @default CHARS_PER_TOKEN 4
 * @param MAX_DOC_TOKENS - Whole-document ceiling; anything past it is dropped.
 * @param MAX_CHUNKS - Maximum chunks to read.
 * @returns The document text, whether it was truncated, and row metadata.
 */
export async function readToolDocument(
  userId: string,
  args: z.infer<typeof documentParams>,
  CHARS_PER_TOKEN = 4,
  /** Whole-document ceiling, in tokens. */
  MAX_DOC_TOKENS = envInt("DOCUMENT_MAX_TOKENS", 3000),
  /** Per-chunk ceiling; chunks are produced before this cap exists. */
  CHUNK_TOKEN_CAP = envInt("DOCUMENT_CHUNK_TOKENS", 1000),
  /** Chunks returned by one read. The tool schema allows at most 10. */
  MAX_CHUNKS_PER_READ = 10,
) {
  const MAX_INLINE_CHARS = MAX_DOC_TOKENS * CHARS_PER_TOKEN * 2;
  const { documentId, chunkStart, chunkEnd } = args;
  const isChunkedRequest = chunkStart !== undefined;

  const document = await getDb()
    .selectFrom("documents as d")
    .leftJoin("document_chunks as c", "c.document_id", "d.id")
    .select(["d.id as id", "d.title as title", "d.created_at as createdAt"])
    .select(
      isChunkedRequest
        ? sql<string>`''`.as("rawContent")
        : sql<string>`substr(d.raw_content, 1, ${sql.lit(MAX_INLINE_CHARS)})`.as(
            "rawContent",
          ),
    )
    .select(
      // Typed as the union because the comparison is dialect-dependent: Postgres
      // yields `true`/`false`, SQLite yields `1`/`0`.
      sql<
        boolean | number
      >`length(d.raw_content) > ${sql.lit(MAX_INLINE_CHARS)}`.as("isLargeFile"),
    )
    .select(sql<number>`count(c.id)`.as("chunkCount"))
    .where("d.id", "=", documentId)
    .where("d.user_id", "=", userId)
    .groupBy(["d.id", "d.title", "d.created_at", "d.raw_content"])
    .executeTakeFirst();

  if (!document) return null;

  const chunkCount = document.chunkCount;

  if (!isChunkedRequest) {
    const { text: safeContent, truncated } = truncateToTokens(
      document.rawContent,
      MAX_DOC_TOKENS,
      CHARS_PER_TOKEN,
    );

    return {
      id: document.id,
      title: truncateToTokens(document.title, 100, CHARS_PER_TOKEN).text,
      content: safeContent,
      truncated: Boolean(document.isLargeFile) || truncated,
      chunkCount,
      nextChunkStart: chunkCount > 0 ? 0 : null,
    };
  }

  if (chunkEnd === undefined) {
    throw new Error("chunkEnd is required when chunkStart is supplied");
  }

  const rawChunks = await getDb()
    .selectFrom("document_chunks as c")
    .innerJoin("documents as d", "d.id", "c.document_id")
    .select(["c.chunk_index as index", "c.chunk_text as content"])
    .where("c.document_id", "=", documentId)
    .where("d.user_id", "=", userId)
    .where("c.chunk_index", ">=", chunkStart)
    .where("c.chunk_index", "<=", chunkEnd)
    .orderBy("c.chunk_index", "asc")
    .orderBy("c.id", "asc")
    .limit(MAX_CHUNKS_PER_READ)
    .execute();

  const lastIndex = rawChunks.at(-1)?.index ?? null;
  const nextChunkStart =
    lastIndex !== null && lastIndex + 1 < chunkCount ? lastIndex + 1 : null;

  return {
    id: document.id,
    title: truncateToTokens(document.title, 100, CHARS_PER_TOKEN).text,
    chunkCount,
    chunkStart,
    chunkEnd,
    chunks: rawChunks.map((chunk) => {
      const tokenized = truncateToTokens(
        chunk.content,
        CHUNK_TOKEN_CAP,
        CHARS_PER_TOKEN,
      );
      return {
        index: chunk.index,
        content: tokenized.text,
        truncated: tokenized.truncated,
      };
    }),
    nextChunkStart,
  };
}
