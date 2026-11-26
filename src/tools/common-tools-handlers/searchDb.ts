import z from "zod";
import { ToolHandler } from "../../types/ToolExecutionTypes";
import { toolError } from "../execution";
import { searchDbDocs, searchParams } from "../../models/searchDbDocs";
import { getConfiguration } from "../../config/config";

/**
 * Search the indexed documents for chunks relevant to a query.
 *
 * @returns A handler that takes a search query and returns matching chunks with
 * their similarity score.
 */
export function searchDb(userId?: string): ToolHandler {
  const log = getConfiguration().logger;
  return async (args) => {
    log.debug({ args }, "agent ran tool searchDb");
    const parse = searchParams.safeParse(args);

    if (!parse.success) {
      return toolError("VALIDATION_ERROR", JSON.stringify(parse.error.issues));
    }

    const query = parse.data;

    try {
      const res = await searchDbDocs(query, userId);

      if ("ok" in res && !res.ok) return { results: [] };

      const rows = z.array(z.record(z.string(), z.unknown())).parse(res);

      const results = rows.map((row) => ({
        chunkId: row.id,
        documentId: row.documentId,
        title: row.title,
        content: row.chunkText,
        chunkIndex: row.chunkIndex,
        similarity: row.similarity,
        retrievedAt: row.retrievedAt,
      }));

      return { results };
    } catch (err) {
      log.error(
        { err },
        "Database search failed or returned an invalid response.",
      );
      return toolError(
        "DB_SEARCH_FAILED",
        "Database search failed or returned an invalid response.",
      );
    }
  };
}
