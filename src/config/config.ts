import { createConfigManager, MiniCache } from "@riavzon/utils";
import {
  configSchema,
  Configuration,
  ConfigurationInput,
} from "./configSchema";
import type Redis from "ioredis";
import type OpenAI from "openai";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { createLibMigrator } from "../db/migration";
import { Database } from "../db/schema";
import { loadPeer } from "../utils/loadPeerDepend";

const { defineConfiguration, getConfiguration } =
  createConfigManager<Configuration>(configSchema, "@riavzon/ai Package");

let globalCache: Redis | MiniCache | undefined;
let globalDb: Kysely<Database> | undefined;
let aiClient: OpenAI | undefined;
let embeddingClient: OpenAI | undefined;

/**
 * Initialise the package: storage, database and AI clients.
 *
 * Call once and await it before anything else. Runs the migrations on first
 * use. Calling it twice keeps the clients the first call created.
 *
 * @param config - Storage backend, database target and OpenAI clients.
 * @throws If `db` is missing or a migration fails.
 * @example
 * ```ts
 * await configuration({
 *   db: "./data/app.db",
 *   openAiConfig: new OpenAI({ apiKey }),
 *   embeddingConfig: {
 *     dimensions: 1536,
 *     matchingModel: "text-embedding-3-small",
 *     retrievalModel: "text-embedding-3-small",
 *   },
 * });
 * ```
 */
export async function configuration(config: ConfigurationInput): Promise<void> {
  const initStorageTask = () => {
    globalCache ??= config.redis === "memory" ? new MiniCache() : config.redis;
  };

  const initDbTask = async () => {
    if (config.db === undefined) {
      throw new Error("Database configuration is required.");
    }
    const dbConfig = config.db;

    let dialect: SqliteDialect | PostgresDialect;
    const isPostgres = typeof dbConfig !== "string";

    if (isPostgres) {
      dialect = new PostgresDialect({ pool: dbConfig });
    } else {
      const { default: SQLite } = await loadPeer<{
        default: typeof import("better-sqlite3");
      }>("better-sqlite3", "the sqlite storage backend");
      const sqliteVec = await loadPeer<typeof import("sqlite-vec")>(
        "sqlite-vec",
        "vector search on sqlite",
      );
      const sqlite = new SQLite(config.db as string);
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("synchronous = NORMAL");
      sqlite.pragma("foreign_keys = ON");
      sqliteVec.load(sqlite);
      dialect = new SqliteDialect({ database: sqlite });
    }
    const db = new Kysely<Database>({ dialect });

    const migrator = createLibMigrator(
      db,
      isPostgres,
      config.embeddingConfig.dimensions,
    );
    const { error, results } = await migrator.migrateToLatest();
    results?.forEach((it) => {
      if (it.status === "Error") {
        console.error(`Failed to execute migration "${it.migrationName}"`);
      }
    });

    if (error) {
      await db.destroy();
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);
      throw new Error(message);
    }

    globalDb ??= db;
  };

  const initAiClientsTasks = () => {
    aiClient ??= config.openAiConfig;
    embeddingClient ??= config.embeddingConfig.client;
  };

  await defineConfiguration(config, [
    initStorageTask,
    initDbTask,
    initAiClientsTasks,
  ]);
}

export { getConfiguration };

export function getStorage(): Redis | MiniCache {
  if (!globalCache) {
    console.trace("Premature getStorage() call");
    throw new Error("Storage not ready. Call configuration() first.");
  }
  return globalCache;
}

/**
 * Read one cached value.
 *
 * @param key - Cache key.
 * @returns The stored value, or `null` when absent or expired.
 * @throws If `configuration()` has not run yet.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const store = getStorage();
  if (store instanceof MiniCache) {
    const value = store.get(key) as T | null;
    return value;
  }
  return (await store.get(key)) as T | null;
}

/**
 * Write one cached value.
 *
 * @param key - Cache key.
 * @param value - Value to store.
 * @param ttlMs - Lifetime in milliseconds. Rounded up to whole seconds on
 * Redis, which cannot expire in fractions.
 * @throws If `configuration()` has not run yet.
 */
export async function cacheSet(
  key: string,
  value: string,
  ttlMs: number,
): Promise<void> {
  const store = getStorage();
  if (store instanceof MiniCache) {
    store.set(key, value, ttlMs);
    return;
  }
  await store.setex(key, Math.max(1, Math.ceil(ttlMs / 1000)), value);
}

/**
 * Read several cached values at once.
 *
 * @param keys - Keys to read. An empty array returns `[]` without a round trip.
 * @returns Values in the same order as `keys`, `null` for absent entries.
 * @throws If `configuration()` has not run yet.
 */
export async function cacheGetMany(
  keys: readonly string[],
): Promise<(string | null)[]> {
  if (keys.length === 0) return [];

  const store = getStorage();
  if (store instanceof MiniCache) {
    return keys.map((key) => store.get(key) as string | null);
  }
  return store.mget(...keys);
}

/**
 * Write several cached values with one shared lifetime.
 *
 * Pipelined on Redis, so it is one round trip.
 *
 * @param entries - Key/value pairs to write.
 * @param ttlMs - Shared lifetime in milliseconds.
 * @throws If `configuration()` has not run yet.
 */
export async function cacheSetMany(
  entries: readonly { key: string; value: string }[],
  ttlMs: number,
): Promise<void> {
  if (entries.length === 0) return;

  const store = getStorage();
  if (store instanceof MiniCache) {
    for (const entry of entries) store.set(entry.key, entry.value, ttlMs);
    return;
  }

  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  const pipeline = store.pipeline();
  for (const entry of entries) {
    pipeline.setex(entry.key, ttlSeconds, entry.value);
  }
  await pipeline.exec();
}

export function getDb(): Kysely<Database> {
  if (!globalDb) {
    console.trace("Premature getDb() call");
    throw new Error("DB not ready. Call configuration() first.");
  }
  return globalDb;
}

/**
 * An OpenAI client from the configuration.
 *
 * @param type - `"embedding"` for the embeddings client, `"default"` for chat.
 * Falls back to the chat client when no separate embeddings client is set.
 * @default type = "default"
 * @returns The configured client.
 * @throws If `configuration()` has not run yet.
 * @example
 * ```ts
 * const embeddings = aiClients("embedding");
 * ```
 */
export function aiClients(type: "embedding" | "default" = "default"): OpenAI {
  if (!aiClient) {
    console.trace("Premature aiClients call");
    throw new Error("Ai clients not ready. Call configuration() first.");
  }

  if (type === "embedding") return embeddingClient ?? aiClient;

  return aiClient;
}
