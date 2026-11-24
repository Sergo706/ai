/** One embedded slice of a scrape, ready for storage. */
export interface PreparedChunk<C = undefined> {
  /** Zero-based position of the chunk in the scrape. */
  chunkIndex: number;
  /** The chunk text that was embedded. */
  chunkText: string;
  /** Embedding of `chunkText`. */
  embedding: number[];
  /** Per-chunk metadata produced by `chunkMeta`, when one was given. */
  customFields?: C;
}

/** A scrape split into embedded chunks, with the text they came from. */
export interface PreparedScrape<T, C = undefined> {
  /** Page or document title. */
  title: string;
  /** The formatted text that was chunked. */
  fullContent: string;
  /** Structured scrape output, passed through untouched. */
  jsonData: T;
  /** Embedded chunks, in order. */
  chunks: PreparedChunk<C>[];
}
