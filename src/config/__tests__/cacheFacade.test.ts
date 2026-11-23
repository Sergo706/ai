import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config.js";

/**
 * The cache facade and the accessor guards in `src/config/config.ts`.
 *
 * Every caller of the library reaches storage through these five helpers, and
 * each one branches on the backend: `MiniCache` is synchronous, a real Redis is
 * not. A regression here is silent — a Redis call without `await` returns a
 * promise the caller stores as a string — so both backends are exercised, the
 * memory one through the ordinary boot and the Redis one through a transport
 * stand-in that still satisfies the schema's duck-typed check.
 */

interface RedisLike {
  get: (key: string) => Promise<string | null>;
  setex: (key: string, ttl: number, value: string) => Promise<"OK">;
  mget: (...keys: string[]) => Promise<(string | null)[]>;
  pipeline: () => {
    setex: (key: string, ttl: number, value: string) => unknown;
    exec: () => Promise<unknown[]>;
  };
}

/**
 * A schema-valid Redis stand-in.
 *
 * `configSchema` accepts any object with `duplicate`, `pipeline` and `xadd`
 * functions, so this can stand in for ioredis without a server. It is a fake for
 * the *transport* only: the branch under test is which method `config.ts`
 * chooses and how it awaits the result, not Redis semantics.
 */
function redisLike(): RedisLike & { writes: unknown[][]; duplicate: () => never; xadd: () => never } {
  const store = new Map<string, string>();
  const writes: unknown[][] = [];
  return {
    writes,
    duplicate: () => {
      throw new Error("not used");
    },
    xadd: () => {
      throw new Error("not used");
    },
    get: (key) => Promise.resolve(store.get(key) ?? null),
    setex: (key, ttl, value) => {
      writes.push(["setex", key, ttl, value]);
      store.set(key, value);
      return Promise.resolve("OK" as const);
    },
    mget: (...keys) => Promise.resolve(keys.map((key) => store.get(key) ?? null)),
    pipeline: () => {
      const queued: unknown[][] = [];
      return {
        setex: (key: string, ttl: number, value: string) => {
          queued.push([key, ttl, value]);
          return undefined;
        },
        exec: () => {
          for (const [key, ttl, value] of queued) {
            writes.push(["pipeline.setex", key, ttl, value]);
            store.set(key as string, value as string);
          }
          return Promise.resolve(queued);
        },
      };
    },
  };
}

let env: LoadedConfig | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

describe("cache facade on MiniCache", () => {
  it("reads back what it wrote and honours the miss case", async () => {
    env = await loadConfig({ dialect: "sqlite" });

    expect(await env.mod.cacheGet("missing")).toBeNull();
    await env.mod.cacheSet("k", "v", 5_000);
    expect(await env.mod.cacheGet("k")).toBe("v");
  });

  it("returns an empty page for an empty key list without touching storage", async () => {
    env = await loadConfig({ dialect: "sqlite" });

    // The guard exists so a caller does not pay for a round trip with no keys.
    expect(await env.mod.cacheGetMany([])).toEqual([]);
    await env.mod.cacheSet("k", "v", 5_000);
    expect(await env.mod.cacheGetMany(["k", "absent"])).toEqual(["v", null]);
  });

  it("writes a batch and is a no-op for an empty one", async () => {
    env = await loadConfig({ dialect: "sqlite" });

    await env.mod.cacheSetMany([], 5_000);
    await env.mod.cacheSetMany(
      [
        { key: "a", value: "1" },
        { key: "b", value: "2" },
      ],
      5_000,
    );

    expect(await env.mod.cacheGetMany(["a", "b"])).toEqual(["1", "2"]);
  });
});

describe("cache facade on a Redis-shaped store", () => {
  it("uses setex and reads back through get", async () => {
    const redis = redisLike();
    env = await loadConfig({ dialect: "sqlite", overrides: { redis } as never });

    await env.mod.cacheSet("k", "v", 2_500);

    // TTL is converted to whole seconds and floored at 1, so a sub-second TTL
    // still expires rather than writing 0 (which Redis reads as "never").
    expect(redis.writes).toEqual([["setex", "k", 3, "v"]]);
    expect(await env.mod.cacheGet("k")).toBe("v");
  });

  it("clamps a TTL that rounds down to zero seconds", async () => {
    const redis = redisLike();
    env = await loadConfig({ dialect: "sqlite", overrides: { redis } as never });

    await env.mod.cacheSet("k", "v", 1);

    expect(redis.writes).toEqual([["setex", "k", 1, "v"]]);
  });

  it("reads many keys in one round trip", async () => {
    const redis = redisLike();
    env = await loadConfig({ dialect: "sqlite", overrides: { redis } as never });

    await env.mod.cacheSetMany([{ key: "a", value: "1" }], 5_000);
    expect(await env.mod.cacheGetMany(["a", "missing"])).toEqual(["1", null]);
  });

  it("writes a batch through one pipeline", async () => {
    const redis = redisLike();
    env = await loadConfig({ dialect: "sqlite", overrides: { redis } as never });

    await env.mod.cacheSetMany(
      [
        { key: "a", value: "1" },
        { key: "b", value: "2" },
      ],
      10_000,
    );

    // Both writes share one pipeline, and the TTL is 10 seconds for each.
    expect(redis.writes).toEqual([
      ["pipeline.setex", "a", 10, "1"],
      ["pipeline.setex", "b", 10, "2"],
    ]);
  });

  it("does not open a pipeline for an empty batch", async () => {
    const redis = redisLike();
    env = await loadConfig({ dialect: "sqlite", overrides: { redis } as never });

    await env.mod.cacheSetMany([], 10_000);

    expect(redis.writes).toEqual([]);
  });
});

describe("accessor guards before configuration", () => {
  it("refuses getDb, getStorage and aiClients on a fresh module", async () => {
    // A fresh module registry has never called `configuration()`, so all three
    // guards fire. `vi.resetModules()` plus a re-import is the only way to reach
    // the "not ready" branch after the setup file configured a database, and it
    // mirrors what `loadConfig` does for the rest of the suite.
    const { vi } = await import("vitest");
    vi.resetModules();
    const fresh = await import("../../config/config.js");

    expect(() => fresh.getDb()).toThrow("DB not ready. Call configuration() first.");
    expect(() => fresh.getStorage()).toThrow(
      "Storage not ready. Call configuration() first.",
    );
    expect(() => fresh.aiClients()).toThrow(
      "Ai clients not ready. Call configuration() first.",
    );

    // The configured module is a different instance and stays usable.
    env = await loadConfig({ dialect: "sqlite" });
    const inserted = await env.mod
      .getDb()
      .insertInto("documents")
      .values({ raw_content: "x", content_hash: "h", title: "t" })
      .returning("id")
      .executeTakeFirstOrThrow();
    expect(inserted.id).toBe(1);
  });
});

describe("aiClients routing", () => {
  it("returns the chat client for the default type", async () => {
    env = await loadConfig({ dialect: "sqlite" });

    expect(env.mod.aiClients()).toBe(env.mod.getConfiguration().openAiConfig);
    expect(env.mod.aiClients("default")).toBe(
      env.mod.getConfiguration().openAiConfig,
    );
  });

  it("returns the embedding client when one was supplied", async () => {
    env = await loadConfig({ dialect: "sqlite" });

    expect(env.mod.aiClients("embedding")).toBe(
      env.mod.getConfiguration().embeddingConfig.client,
    );
  });

  it("falls back to the chat client when no embedding client was supplied", async () => {
    // `embeddingConfig.client` is optional in the schema; the fallback is what
    // lets a caller configure one client and still generate embeddings.
    env = await loadConfig({
      dialect: "sqlite",
      overrides: {
        embeddingConfig: {
          dimensions: 8,
          matchingModel: "m",
          retrievalModel: "r",
        },
      },
    });

    expect(env.mod.getConfiguration().embeddingConfig.client).toBeUndefined();
    expect(env.mod.aiClients("embedding")).toBe(
      env.mod.getConfiguration().openAiConfig,
    );
  });
});
