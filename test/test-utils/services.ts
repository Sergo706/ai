import type Redis from "ioredis";
import { sql, type Kysely } from "kysely";

import type { Database } from "../../src/db/schema";

export interface ServiceTargets {
  postgres: string;
  redis: string;
}

/**
 * Truncates every table the library owns.
 *
 * `TRUNCATE ... RESTART IDENTITY CASCADE` is used rather than a loop of
 * `DELETE`s: it resets the sequences, so an id assertion (`id === 1`) is stable
 * across tests, and the cascade covers the `document_chunks → documents` foreign
 * key without an ordered dance.
 *
 * Both dialects are handled, because a model test that only runs on Postgres
 * says nothing about the SQLite branch — and that branch is the default.
 */
export async function truncateAll(
  db: Kysely<Database>,
  dialect: "postgres" | "sqlite",
): Promise<void> {
  const tables = [
    "runs",
    "messages",
    "conversations",
    "document_chunks",
    "documents",
  ];

  if (dialect === "postgres") {
    await sql
      .raw(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`)
      .execute(db);
    return;
  }

  // SQLite has no `TRUNCATE`; deleting in foreign-key order and resetting
  // `sqlite_sequence` is the equivalent.
  await db.deleteFrom("runs").execute();
  await db.deleteFrom("messages").execute();
  await db.deleteFrom("conversations").execute();
  await db.deleteFrom("document_chunks").execute();
  await db.deleteFrom("documents").execute();
  await db
    .deleteFrom("sqlite_sequence" as never)
    .execute()
    .catch(() => undefined);
}

/**
 * Deletes every key the library writes.
 *
 * The run streams are namespaced `run:<id>:events` and the tool cache is
 * `toolcache:*`, so a scan on those two prefixes is enough and cannot touch an
 * unrelated database on a shared server.
 */
export async function flushRedis(redis: Redis): Promise<void> {
  for (const pattern of ["run:*", "toolcache:*"]) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        500,
      );
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  }
}

/** True when the server answered `PING`. Used to fail with a clear message. */
export async function redisIsReachable(redis: Redis): Promise<boolean> {
  try {
    // ioredis types `ping()` as the literal "PONG", but a real server is the
    // only authority on liveness, so widen before comparing.
    const reply: string = await redis.ping();
    return reply === "PONG";
  } catch {
    return false;
  }
}
