import { sql } from "kysely";
import { getConfiguration } from "../config/config";

/**
 * `JSON.stringify`, preserving `null`/`undefined` as `null`.
 *
 * @param val - Any JSON-serialisable value.
 * @returns The serialised string, or `null` for `null`/`undefined` input.
 */
export const toJson = (val: unknown) =>
  val == null ? null : JSON.stringify(val);

/**
 * Parse a JSON column back into a value.
 *
 * A no-op for values the driver already parsed (`jsonb`, `JSONColumnType`), so
 * it is safe on both dialects.
 *
 * @param val - A JSON string, an already-parsed value, or `null`.
 * @returns The parsed value, or `null`.
 */
export const fromJson = <T>(val: T | string | null): T | null =>
  typeof val === "string" ? (JSON.parse(val) as T) : val;


export function isPg(): boolean {
  const { db } = getConfiguration();
  return typeof db !== "string" && "connect" in db && "query" in db;
}

/**
 * A timestamp the active database dialect accepts, as an ISO string.
 *
 * @param offsetMs - Milliseconds added to now; use a negative value for the past.
 * @returns An ISO 8601 string, e.g. `2026-01-31T09:00:00.000Z`.
 * @default offsetMs 0
 * @example
 * ```ts
 * await db.updateTable("runs").set({ finished_at: timestamp() });
 * ```
 */
export function timestamp(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * Encode an embedding for the active dialect.
 *
 * @param vec - The embedding, or `null`/`undefined` for a missing vector.
 * @returns `null` for empty input, a pgvector literal string on Postgres, or a
 * `Float32Array` blob on SQLite.
 * @throws If the length does not match `embeddingConfig.dimensions`.
 */
export function toVec(vec: number[] | null | undefined) {
  const config = getConfiguration();

  if (!vec) return null;
  if (vec.length !== config.embeddingConfig.dimensions)
    throw new Error(
      `Expected ${config.embeddingConfig.dimensions.toString()} dims, got ${vec.length.toString()}`,
    );

  return isPg()
    ? `[${vec.join(",")}]`
    : new Uint8Array(new Float32Array(vec).buffer);
}


/**
 * A dialect-portable distance expression for the query embedding.
 *
 * Lower is closer in both cases, but the scales are not identical: `<=>` is
 * cosine distance on Postgres while `vec_distance_cosine` is used on SQLite.
 *
 * @param queryEmbedding - The vector to measure against each row's `embedding`.
 * @returns A Kysely `sql` fragment, to be selected or ordered by.
 */
export const getDistance = (queryEmbedding: number[]) => {
  const param = toVec(queryEmbedding);

  return isPg()
    ? sql<number>`embedding <=> ${param}::vector`
    : sql<number>`case when embedding is null then null else vec_distance_cosine(embedding, ${param}) end`;
};
