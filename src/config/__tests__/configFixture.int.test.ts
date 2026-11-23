import { MiniCache } from "@riavzon/utils";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";
import { truncateAll } from "~~/test/test-utils/services";
import { INTEGRATION_PG_URL, INTEGRATION_REDIS_URL } from "~~/test/integration.setup";

/**
 * The fixture itself is the thing under test here: every other integration
 * suite depends on it reaching a real Postgres and a real Redis and creating
 * the schema with the right vector width. If it silently fell back to SQLite,
 * the dialect branch would be untested and nothing else would notice.
 */

describe("loadConfig", () => {
  let env: LoadedConfig | undefined;

  afterEach(async () => {
    await env?.cleanup();
    env = undefined;
  });

  it("configures real PostgreSQL and runs the pg migrator", async () => {
    env = await loadConfig({ dialect: "pg", pgUrl: INTEGRATION_PG_URL });

    expect(env.mod.getConfiguration().db).toBe(env.pool);

    // The database is shared between integration files, so its sequence is
    // wherever the previous suite left it. `truncateAll` issues
    // `RESTART IDENTITY`, which is the only way the id below is predictable.
    await truncateAll(env.mod.getDb(), "postgres");

    const row = await env.mod
      .getDb()
      .insertInto("documents")
      .values({ raw_content: "body", content_hash: "pg-hash", title: "t" })
      .returning("id")
      .executeTakeFirstOrThrow();

    expect(row.id).toBe(1);
  });

  it("creates the vector extension on postgres, so a real embedding round trips", async () => {
    env = await loadConfig({ dialect: "pg", pgUrl: INTEGRATION_PG_URL });

    const doc = await env.mod
      .getDb()
      .insertInto("documents")
      .values({ raw_content: "body", content_hash: "vec-hash", title: "t" })
      .returning("id")
      .executeTakeFirstOrThrow();

    const embedding = `[${Array.from({ length: env.dimensions }, (_, i) => i).join(",")}]`;
    await env.mod
      .getDb()
      .insertInto("document_chunks")
      .values({
        document_id: doc.id,
        chunk_text: "chunk",
        embedding,
      })
      .execute();

    const stored = await env.mod
      .getDb()
      .selectFrom("document_chunks")
      .select("embedding")
      .executeTakeFirstOrThrow();

    // pgvector returns the text form of the vector, not a JS array.
    expect(String(stored.embedding)).toBe(embedding);
  });

  it("configures SQLite with the same schema", async () => {
    env = await loadConfig({ dialect: "sqlite" });

    expect(typeof env.mod.getConfiguration().db).toBe("string");

    const row = await env.mod
      .getDb()
      .insertInto("documents")
      .values({ raw_content: "body", content_hash: "sqlite-hash", title: "t" })
      .returning("id")
      .executeTakeFirstOrThrow();

    expect(row.id).toBe(1);
  });

  it("uses MiniCache for storage unless a Redis url is given", async () => {
    env = await loadConfig({ dialect: "sqlite" });

    // `getStorage` returns the real store; MiniCache is the in-memory branch.
    // `instanceof` rather than `constructor.name`, because the packaged class
    // name is minified.
    expect(env.mod.getStorage()).toBeInstanceOf(MiniCache);
  });

  it("uses the real Redis client when a url is given", async () => {
    env = await loadConfig({
      dialect: "sqlite",
      redisUrl: INTEGRATION_REDIS_URL,
    });

    const store = env.mod.getStorage();
    expect(store).toBe(env.redis);

    await env.mod.cacheSet("k", "v", 5_000);
    expect(await env.mod.cacheGet("k")).toBe("v");
    expect(await env.redis?.get("k")).toBe("v");
  });

  it("truncates every table and resets the sequences", async () => {
    env = await loadConfig({ dialect: "pg", pgUrl: INTEGRATION_PG_URL });

    await env.mod
      .getDb()
      .insertInto("documents")
      .values({ raw_content: "a", content_hash: "h1", title: "t" })
      .execute();
    await truncateAll(env.mod.getDb(), "postgres");

    expect(
      await env.mod.getDb().selectFrom("documents").selectAll().execute(),
    ).toEqual([]);

    const again = await env.mod
      .getDb()
      .insertInto("documents")
      .values({ raw_content: "b", content_hash: "h2", title: "t" })
      .returning("id")
      .executeTakeFirstOrThrow();
    // `RESTART IDENTITY` is what makes id assertions stable across tests.
    expect(again.id).toBe(1);
  });
});
