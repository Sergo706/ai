export interface PreparedChunk<C = undefined> {
  chunkIndex: number;
  chunkText: string;
  embedding: number[];
  /**
   * Per-chunk metadata produced by `chunkMeta`.
   *
   */
  customFields?: C;
}

export interface PreparedScrape<T, C = undefined> {
  title: string;
  fullContent: string;
  jsonData: T;
  chunks: PreparedChunk<C>[];
}
