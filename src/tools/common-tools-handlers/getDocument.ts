import { getConfiguration } from "../../config/config";
import { readToolDocument } from "../../models/toolContent";
import type { ToolHandler } from "../../types/ToolExecutionTypes";
import { toolError } from "../execution";
import { documentParams } from "./schemas";

export interface GetDocumentOptions {
  /** Chars per token used by every truncation in this tool. */
  charsPerToken?: number;
  /** Whole-document ceiling, in tokens. */
  maxDocTokens?: number;
  /** Per-chunk ceiling; chunks are produced before this cap exists. */
  chunkTokenCap?: number;
  /** Chunks returned by one read. The tool schema allows at most 10. */
  maxChunksPerRead?: number;
}


export function getDocument(
  userId: string,
  options: GetDocumentOptions = {},
): ToolHandler {
  const {
    charsPerToken = 4,
    maxDocTokens = 3_000,
    chunkTokenCap = 1_000,
    maxChunksPerRead = 10,
  } = options;

  const log = getConfiguration().logger;

  return async (args) => {
    log.debug({ args }, "agent ran tool getDocument");

    const parsed = documentParams.safeParse(args);

    if (!parsed.success)
      return toolError("VALIDATION_ERROR", JSON.stringify(parsed.error.issues));

    const { chunkStart, chunkEnd } = parsed.data;

    if (
      (chunkStart === undefined) !== (chunkEnd === undefined) ||
      (chunkStart !== undefined &&
        chunkEnd !== undefined &&
        (chunkEnd < chunkStart || chunkEnd - chunkStart >= maxChunksPerRead))
    ) {
      return toolError(
        "VALIDATION_ERROR",
        `Supply both inclusive chunk indexes, selecting at most ${String(maxChunksPerRead)} chunks.`,
      );
    }

    try {
      const res = await readToolDocument(
        userId,
        parsed.data,
        charsPerToken,
        maxDocTokens,
        chunkTokenCap,
        maxChunksPerRead,
      );

      if (!res) return toolError("NOT_FOUND", "Document not found or access denied.");

      return res;
    } catch (err) {
      log.error({ err }, "Unable to retrieve document.");
      return toolError("DOCUMENT_FAILED", "Unable to retrieve document.");
    }
  };
}
