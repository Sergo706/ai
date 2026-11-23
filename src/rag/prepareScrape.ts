import { chunkProcess } from "@riavzon/utils";
import { chunkByTokens } from "../utils/chunkTextByTokens";
import { PreTrainedTokenizer } from "@huggingface/transformers";
import { generateEmbedding } from "./embedding";
import { getConfiguration } from "../config/config";
import { PreparedChunk, PreparedScrape } from "../types/PrepareScrape";


export interface PrepareScrapeOptions<T, C> {
  /** Tokens per chunk. */
  maxTokens?: number;
  /** Tokens carried from the tail of one chunk into the next. */
  overlapTokens?: number;
  /** Optional tokenizer; when absent, characters/4 is used. */
  tokenizer?: PreTrainedTokenizer;
  /** Fallback ratio for `tokenizer`-less token counting. */
  charsPerTokenEstimate?: number;
  /** Parallel embedding batches. */
  embeddingConcurrency?: number;
  /** Renders the final text that is chunked. Defaults to the raw markdown. */
  formatter?: (title: string, rawText: string, jsonData: T) => string;
  /**
   * Metadata for one chunk, resolved per chunk.
   *
   * Return whatever the host stores alongside a chunk (a source URL, a row of
   * the scraped JSON, a heading path). Called with the chunk's text and its
   * zero-based ordinal so a scrape whose chunks come from different places can
   * label them individually. Omit it and chunks carry no `customFields`.
   */
  chunkMeta?: (chunkText: string, chunkIndex: number) => C;
}

export async function prepareScrape<T, C = undefined>(
  title: string,
  rawMarkdown: string,
  jsonData: T,
  options: PrepareScrapeOptions<T, C> = {},
): Promise<PreparedScrape<T, C>> {
  const {
    maxTokens = 1000,
    overlapTokens = 100,
    tokenizer,
    charsPerTokenEstimate = 4,
    embeddingConcurrency = 10,
    formatter,
    chunkMeta,
  } = options;

  const fullContent = formatter
    ? formatter(title, rawMarkdown, jsonData)
    : rawMarkdown;

  const chunkTexts = chunkByTokens(
    fullContent,
    maxTokens,
    overlapTokens,
    tokenizer,
    charsPerTokenEstimate,
  );

  const chunks: PreparedChunk<C>[] = [];
  const { embeddingConfig } = getConfiguration();

  await chunkProcess(
    chunkTexts,
    embeddingConcurrency,
    async (chunkBatch, startIndex) => {
      const preparedBatch = await Promise.all(
        chunkBatch.map(async (chunkText, offset): Promise<PreparedChunk<C>> => {
          const chunkIndex = startIndex + offset;
          const embedding = await generateEmbedding(chunkText);

          if (
            embedding.length !== embeddingConfig.dimensions ||
            embedding.some((value) => !Number.isFinite(value)) ||
            embedding.every((value) => value === 0)
          ) {
            throw new Error(
              `Expected a non-zero embedding containing ${embeddingConfig.dimensions.toString()} finite numbers`,
            );
          }

          return {
            chunkIndex,
            chunkText,
            embedding,
            ...(chunkMeta ? { customFields: chunkMeta(chunkText, chunkIndex) } : {}),
          };
        }),
      );

      chunks.push(...preparedBatch);
    },
  );

  return {
    title,
    fullContent,
    jsonData,
    chunks,
  };
}

