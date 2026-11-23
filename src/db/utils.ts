import { sql } from "kysely";
import { getConfiguration } from "../config/config";

export const toJson = (val: unknown) =>
  val == null ? null : JSON.stringify(val);
export const fromJson = <T>(val: T | string | null): T | null =>
  typeof val === "string" ? (JSON.parse(val) as T) : val;


export function isPg(): boolean {
  const { db } = getConfiguration();
  return typeof db !== "string" && "connect" in db && "query" in db;
}

/**
 * A timestamp value the active dialect can actually bind.
 *
 * `better-sqlite3` accepts only numbers, strings, bigints, buffers and null —
 * a `Date` throws "SQLite3 can only bind numbers, strings, bigints, buffers,
 * and null". Postgres accepts both, so the only portable choice is a string.
 *
 * Everything that writes a timestamp column must go through this, including
 * comparison bounds: a `Date` in a `WHERE` fails exactly the same way it does in
 * a `SET`, which is what silently broke the lease on sqlite.
 */
export function timestamp(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

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


export const getDistance = (queryEmbedding: number[]) => {
  const param = toVec(queryEmbedding);

  return isPg()
    ? sql<number>`embedding <=> ${param}::vector`
    : sql<number>`case when embedding is null then null else vec_distance_cosine(embedding, ${param}) end`;
};
