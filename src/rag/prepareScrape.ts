import { chunkProcess } from "@riavzon/utils";
import { chunkByTokens } from "../utils/chunkTextByTokens";
import type { PreTrainedTokenizer } from "@huggingface/transformers";
import { generateEmbedding } from "./embedding";
import { getConfiguration } from "../config/config";
import { PreparedChunk, PreparedScrape } from "../types/PrepareScrape";


/** Tuning for {@link prepareScrape}. */
export interface PrepareScrapeOptions<T, C> {
  /**
   * Tokens per chunk.
   *
   * @default 1000
   */
  maxTokens?: number;
  /**
   * Tokens carried from the tail of one chunk into the next.
   *
   * @default 100
   */
  overlapTokens?: number;
  /**
   * Optional tokenizer. When absent, length is estimated from characters.
   */
  tokenizer?: PreTrainedTokenizer;
  /**
   * Characters per token used when no `tokenizer` is given.
   *
   * @default 4
   */
  charsPerTokenEstimate?: number;
  /**
   * Embedding batches run in parallel.
   *
   * @default 10
   */
  embeddingConcurrency?: number;
  /**
   * Renders the final text that is chunked.
   *
   * @default the raw markdown
   */
  formatter?: (title: string, rawText: string, jsonData: T) => string;
  /**
   * Metadata for one chunk, resolved per chunk.
   *
   * Return whatever the host stores alongside a chunk (a source URL, a row of
   * the scraped JSON, a heading path). Called with the chunk's text and its
   * zero-based ordinal, so chunks from different places can be labelled
   * individually. Omit it and chunks carry no `customFields`.
   */
  chunkMeta?: (chunkText: string, chunkIndex: number) => C;
}

/**
 * Turn a scrape into embedded, retrieval-ready chunks.
 *
 * Splits the text with token-aware overlap, embeds every chunk through
 * `embeddingConfig.retrievalModel`, and attaches the per-chunk metadata
 * `chunkMeta` returns.
 *
 * @param title - Page or document title, stored with the scrape.
 * @param rawMarkdown - The scraped body.
 * @param jsonData - Structured scrape output, handed to `formatter`/`chunkMeta`.
 * @param options - Chunking and metadata hooks.
 * @returns The chunks plus the formatted text they came from.
 * @example
 * ```ts
 * const { chunks } = await prepareScrape("Guide", markdown, page, {
 *   chunkMeta: (_text, i) => ({ url: page.url, index: i }),
 * });
 * ```
 */
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

