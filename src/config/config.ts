import { createConfigManager, MiniCache } from "@riavzon/utils";
import {
  configSchema,
  Configuration,
  ConfigurationInput,
} from "./configSchema";
import type Redis from "ioredis";
import OpenAI from "openai";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { createLibMigrator } from "../db/migration";
import { Database } from "../db/schema";

const { defineConfiguration, getConfiguration } =
  createConfigManager<Configuration>(configSchema, "@riavzon/ai Package");

let globalCache: Redis | MiniCache | undefined;
let globalDb: Kysely<Database> | undefined;
let aiClient: OpenAI | undefined;
let embeddingClient: OpenAI | undefined;

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
      const SQLite = (await import("better-sqlite3")).default;
      const sqliteVec = await import("sqlite-vec");
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


export async function cacheGet<T>(key: string): Promise<T | null> {
  const store = getStorage();
  if (store instanceof MiniCache) {
    const value = store.get(key) as T | null;
    return value;
  }
  return await store.get(key) as T | null;
}

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
 * Read several keys in one round trip where the store allows it.
 *
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
 * Write several entries with one TTL, pipelined where the store allows it.
 *
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

export function aiClients(type: "embedding" | "default" = "default"): OpenAI {
  if (!aiClient) {
    console.trace("Premature aiClients call");
    throw new Error("Ai clients not ready. Call configuration() first.");
  }

  if (type === "embedding") return embeddingClient ?? aiClient;

  return aiClient;
}
