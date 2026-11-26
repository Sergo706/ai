import { aiClients, getConfiguration } from "../config/config";

/**
 * Embed text for storage, using `embeddingConfig.retrievalModel`.
 *
 * @param text - Text to embed.
 * @returns The embedding vector.
 * @throws If the model's width differs from `embeddingConfig.dimensions`.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const { embeddingConfig } = getConfiguration();
  const model = await aiClients("embedding").embeddings.create({
    model: embeddingConfig.retrievalModel,
    input: text,
  });
  const res = model.data[0].embedding;
  if (res.length !== embeddingConfig.dimensions) {
    throw new Error(
      `The configured dimensions is not equal to what the embedding model returned. Use ${res.length.toString()} in embeddingConfig.dimensions or a different model`,
    );
  }
  return res;
}

/**
 * Embed a query for retrieval, using `embeddingConfig.matchingModel`.
 *
 * A separate model is allowed because asymmetric search models expect queries
 * and documents to be embedded differently.
 *
 * @param text - Query to embed.
 * @returns The embedding vector.
 * @throws If the model's width differs from `embeddingConfig.dimensions`.
 */
export async function generateMatchingEmbedding(
  text: string,
): Promise<number[]> {
  const { embeddingConfig } = getConfiguration();
  const model = await aiClients("embedding").embeddings.create({
    model: embeddingConfig.matchingModel,
    input: text,
  });

  const res = model.data[0].embedding;
  if (res.length !== embeddingConfig.dimensions) {
    throw new Error(
      `The configured dimensions is not equal to what the embedding model returned. Use ${res.length.toString()} in embeddingConfig.dimensions or a different model`,
    );
  }
  return res;
}
