import { aiClients, getConfiguration } from "../config/config";

export async function generateEmbedding(text: string): Promise<number[]> {
  const {embeddingConfig} = getConfiguration()
  const model = await aiClients("embedding").embeddings.create({
    model: embeddingConfig.retrievalModel,
    input: text,
  });
  const res = model.data[0].embedding;
  if (res.length !== embeddingConfig.dimensions) {
    throw new Error(`The configured dimensions is not equal to what the embedding model returned. Use ${res.length.toString()} in embeddingConfig.dimensions or a different model`)
  }
  return res;
}

export async function generateMatchingEmbedding(
  text: string,
): Promise<number[]> {
  const {embeddingConfig} = getConfiguration()
  const model = await aiClients("embedding").embeddings.create({
    model: embeddingConfig.matchingModel,
    input: text,
  });

  const res = model.data[0].embedding;
  if (res.length !== embeddingConfig.dimensions) {
    throw new Error(`The configured dimensions is not equal to what the embedding model returned. Use ${res.length.toString()} in embeddingConfig.dimensions or a different model`)
  }
  return res;
}
