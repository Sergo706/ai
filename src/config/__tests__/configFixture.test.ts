import { afterEach, describe, expect, it } from "vitest";

import {
  loadConfig,
  type LoadedConfig,
} from "~~/test/test-utils/config.js";

describe("config fixture", () => {
  let env: LoadedConfig | undefined;

  afterEach(async () => {
    await env?.cleanup();
    env = undefined;
  });

  it("boots sqlite and reports it as a non-pg dialect", async () => {
    env = await loadConfig({ dialect: "sqlite" });

    expect(env.dialect).toBe("sqlite");
    expect(env.sqlitePath).toMatch(/test\.db$/);
    expect(env.pool).toBeUndefined();
    expect(env.mod.getConfiguration().db).toBe(env.sqlitePath);
  });

  it("creates the schema so queries run", async () => {
    env = await loadConfig({ dialect: "sqlite" });
    const db = env.mod.getDb();

    const inserted = await db
      .insertInto("documents")
      .values({ raw_content: "hello", content_hash: "h1", title: "t" })
      .returning("id")
      .executeTakeFirstOrThrow();

    expect(inserted.id).toBe(1);
  });
});
