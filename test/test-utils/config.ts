import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Redis from "ioredis";
import OpenAI from "openai";
import type { Pool } from "pg";
import { vi } from "vitest";

import type { ConfigurationInput, Logger } from "../../src/config/configSchema";
import { loadPeer } from "../../src/utils/loadPeerDepend";
import { makeSpyLogger } from "./logger";

type ConfigModule = typeof import("../../src/config/config");

export type TestDialect = "sqlite" | "pg";

export interface LoadedConfig {
  /** The freshly-evaluated config module. */
  mod: ConfigModule;
  /** Active dialect. */
  dialect: TestDialect;
  /** Vector width handed to the migrator. */
  dimensions: number;
  /** Postgres pool for the pg dialect. */
  pool: Pool | undefined;
  /** Redis client when a real server was requested. */
  redis: Redis | undefined;
  /** SQLite file for the sqlite dialect. */
  sqlitePath: string | undefined;
  /** Spies behind the injected logger. */
  logger: ReturnType<typeof makeSpyLogger>;
  /** Drop every row, keeping the schema. */
  truncate: () => Promise<void>;
  /** Release sockets and delete the temp DB. */
  cleanup: () => Promise<void>;
}

export interface LoadConfigOptions {
  /** Storage backend. Defaults to `"sqlite"`. */
  dialect?: TestDialect;
  /** Wide enough for `sqlite-vec` and pgvector. Defaults to `8`. */
  dimensions?: number;
  /** Postgres URL, required for the pg dialect. */
  pgUrl?: string;
  /** Attach a real Redis instead of `MiniCache`. */
  redisUrl?: string;
  /**
   * Merged last, so a test can flip one knob without rebuilding everything.
   * `db`/`redis` here win over `dialect`/`redisUrl`.
   */
  overrides?: Partial<ConfigurationInput>;
  /** Supply a logger other than the spy logger. */
  logger?: Logger;
}

function offlineOpenAi(): OpenAI {
  return new OpenAI({ apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" });
}

let tempDirs: string[] = [];

/**
 * Builds a config module with the storage backend of the caller's choice.
 *
 * `src/config/config.ts` memoises its clients with `??=` and exports no reset,
 * so the only way to exercise a second backend in one process is to drop the
 * module registry and re-import. Every call therefore returns its own module
 * instance plus the resources that instance owns, which `cleanup()` releases.
 *
 * @example
 * ```ts
 * const env = await loadConfig({ dialect: "pg", pgUrl: integrationTargets.postgres });
 * try {
 *   // the pg branch is live here
 * } finally {
 *   await env.cleanup();
 * }
 * ```
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const dialect = options.dialect ?? "sqlite";
  const dimensions = options.dimensions ?? 8;
  const spies = makeSpyLogger();
  const logger = options.logger ?? spies.logger;

  let pool: Pool | undefined;
  let redis: Redis | undefined;
  let sqlitePath: string | undefined;
  let sqliteDir: string | undefined;

  if (dialect === "pg") {
    if (options.pgUrl === undefined) {
      throw new Error("loadConfig: `pgUrl` is required for the pg dialect.");
    }
    const { Pool: PgPool } = await loadPeer<typeof import("pg")>(
      "pg",
      "the postgres test dialect",
    );
    pool = new PgPool({ connectionString: options.pgUrl, max: 4 });
  } else {
    sqliteDir = mkdtempSync(join(tmpdir(), "ai-test-"));
    tempDirs = [...tempDirs, sqliteDir];
    sqlitePath = join(sqliteDir, "test.db");
  }

  if (options.redisUrl !== undefined) {
    const { default: RedisClient } = await loadPeer<typeof import("ioredis")>(
      "ioredis",
      "a real Redis in tests",
    );
    redis = new RedisClient(options.redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
  }

  const storage = pool ?? sqlitePath;

  const input: ConfigurationInput = {
    db: storage,
    redis: redis ?? "memory",
    openAiConfig: offlineOpenAi(),
    embeddingConfig: {
      client: offlineOpenAi(),
      dimensions,
      matchingModel: "test-embedding",
      retrievalModel: "test-embedding",
    },
    logger,
    ...options.overrides,
  };

  vi.resetModules();
  const mod = await import("../../src/config/config");
  await mod.configuration(input);

  const db = mod.getDb();

  return {
    mod,
    dialect,
    dimensions,
    pool,
    redis,
    sqlitePath,
    logger: spies,
    truncate: async () => {
      await db.deleteFrom("runs").execute();
      await db.deleteFrom("messages").execute();
      await db.deleteFrom("conversations").execute();
      await db.deleteFrom("document_chunks").execute();
      await db.deleteFrom("documents").execute();
    },
    cleanup: async () => {
      await db.destroy().catch(() => {
        // Destroying an already-closed Kysely is a no-op we can ignore.
      });
      await pool?.end().catch(() => {
        // A pool that never connected is already closed.
      });
      redis?.disconnect();
      if (sqliteDir !== undefined) {
        tempDirs = tempDirs.filter((dir) => dir !== sqliteDir);
        rmSync(sqliteDir, { recursive: true, force: true });
      }
    },
  };
}

/** Removes temp directories left behind by a test that threw before cleanup. */
export function sweepTempDirs(): void {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
}
