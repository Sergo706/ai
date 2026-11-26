import { afterEach, describe, expect, it } from "vitest";

import { INTEGRATION_REDIS_URL } from "~~/test/integration.setup";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";

/**
 * The run event log, against a real Redis.
 *
 * Both backends are exercised because the dispatch in `appendEvent`/`readPage`/
 * `waitForNext` is the seam that decides whether a run survives a replica
 * hand-off. Forcing the Redis branch matters most: the memory branch uses the
 * same in-process arrays as the registry, so a bug in the XADD/XRANGE id
 * arithmetic would be invisible there.
 */

type EventStore = typeof import("../eventStore/index.js");
type Shared = typeof import("../eventStore/shared.js");

interface Harness {
  store: EventStore;
  shared: Shared;
  /** The raw ioredis client the backend is talking to. */
  redis: NonNullable<LoadedConfig["redis"]>;
  cleanup: () => Promise<void>;
}

const RUN = "run-int-1";

/**
 * `redisStreams()` reads the client from the process-wide configuration, so the
 * module has to be imported after `loadConfig` and the client has to be a real
 * server rather than `MiniCache`.
 */
async function bootRedis(): Promise<Harness> {
  const env = await loadConfig({ redisUrl: INTEGRATION_REDIS_URL });
  if (!env.redis) throw new Error("Expected a real Redis client");

  const store = await import("../eventStore/index.js");
  const shared = await import("../eventStore/shared.js");

  // A previous run of this file may have left entries behind.
  await env.redis.del(shared.streamKey(RUN));

  return {
    store,
    shared,
    redis: env.redis,
    cleanup: async () => {
      await env.redis?.del(shared.streamKey(RUN));
      await env.cleanup();
    },
  };
}

/** Boots the memory backend (no `redisUrl`), which `MiniCache` represents. */
async function bootMemory(): Promise<{
  store: EventStore;
  shared: Shared;
  cleanup: () => Promise<void>;
}> {
  const env = await loadConfig();
  const store = await import("../eventStore/index.js");
  const shared = await import("../eventStore/shared.js");
  return { store, shared, cleanup: env.cleanup };
}

let env: Harness | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

describe("eventStore — real Redis", () => {
  it("appends into a real Redis stream under the run's key", async () => {
    env = await bootRedis();

    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    const entries = await env.redis.xrange(env.shared.streamKey(RUN), "-", "+");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toBe("1000-0");
  });

  it("round-trips the event payload through JSON", async () => {
    env = await bootRedis();

    await env.store.appendEvent(RUN, "1000-0", {
      type: "chunk",
      text: "hello",
    });

    const page = await env.store.readPage(RUN, env.shared.FIRST_ID, 10);
    expect(page.events).toEqual([{ type: "chunk", text: "hello" }]);
  });

  it("reads strictly after the cursor, never re-returning it", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });
    await env.store.appendEvent(RUN, "1000-1", { type: "chunk", text: "b" });
    await env.store.appendEvent(RUN, "1000-2", { type: "chunk", text: "c" });

    const page = await env.store.readPage(RUN, "1000-1", 10);

    expect(
      page.events.map((event) => (event as { text: string }).text),
    ).toEqual(["c"]);
    expect(page.lastId).toBe("1000-2");
  });

  it("bounds a page by the requested count", async () => {
    env = await bootRedis();
    for (let i = 0; i < 5; i++) {
      await env.store.appendEvent(RUN, `1000-${String(i)}`, {
        type: "chunk",
        text: String(i),
      });
    }

    const first = await env.store.readPage(RUN, env.shared.FIRST_ID, 2);
    expect(first.events).toHaveLength(2);
    expect(first.lastId).toBe("1000-1");

    const second = await env.store.readPage(RUN, first.lastId, 2);
    expect(second.events).toHaveLength(2);
    expect(second.lastId).toBe("1000-3");
  });

  it("reports the cursor back when the page is empty", async () => {
    env = await bootRedis();

    const page = await env.store.readPage(RUN, "5000-0", 10);

    expect(page.events).toEqual([]);
    // Echoing the cursor (rather than undefined) is what lets a caller keep
    // polling with an unchanged position.
    expect(page.lastId).toBe("5000-0");
  });

  it("sets a TTL on the stream so a settled run expires", async () => {
    env = await bootRedis();

    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    const ttl = await env.redis.ttl(env.shared.streamKey(RUN));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(env.shared.getStreamTtlSeconds());
  });

  it("refreshes the TTL on touch", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });
    // Drop the TTL so the refresh is observable rather than coincidental.
    await env.redis.persist(env.shared.streamKey(RUN));
    expect(await env.redis.ttl(env.shared.streamKey(RUN))).toBe(-1);

    await env.store.touchStream(RUN);

    expect(await env.redis.ttl(env.shared.streamKey(RUN))).toBeGreaterThan(0);
  });

  it("reads the last stream id from a real stream", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-5", { type: "chunk", text: "a" });
    await env.store.appendEvent(RUN, "1000-9", { type: "chunk", text: "b" });

    expect(await env.store.lastStreamId(RUN)).toBe("1000-9");
  });

  it("reports no last id for a stream that does not exist", async () => {
    env = await bootRedis();

    expect(await env.store.lastStreamId("run-never-seen")).toBeUndefined();
  });

  it("drops a settled run's stream", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    await env.store.dropStream(RUN);

    expect(await env.redis.exists(env.shared.streamKey(RUN))).toBe(0);
  });

  it("survives dropping a stream that is not there", async () => {
    env = await bootRedis();
    await expect(
      env.store.dropStream("run-never-seen"),
    ).resolves.toBeUndefined();
  });

  it("wakes a waiting reader when an event is published", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    // Start the wait first, then append on the next tick so the pub/sub wakeup
    // is what resolves it rather than the initial non-blocking read.
    const waiting = env.store.waitForNext(RUN, "1000-0");
    setTimeout(() => {
      void env?.store.appendEvent(RUN, "1000-1", {
        type: "chunk",
        text: "b",
      });
    }, 100);

    const page = await waiting;

    expect(page?.events).toEqual([{ type: "chunk", text: "b" }]);
    expect(page?.lastId).toBe("1000-1");
  });

  it("returns the pending page immediately when one already exists", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    const started = Date.now();
    const page = await env.store.waitForNext(RUN, "999-0");

    // No block should elapse: the initial read must find the entry.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(page?.events).toHaveLength(1);
  });

  it("returns null when the block window expires with nothing new", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    const page = await env.store.waitForNext(RUN, "1000-0");

    expect(page).toBeNull();
  }, 20_000);

  it("keeps ids increasing when the caller reuses an id", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", {
      type: "chunk",
      text: "first",
    });

    // A duplicate id would be silently dropped by XADD; the backend mints a new
    // one instead so no event is ever lost.
    await env.store.appendEvent(RUN, "1000-0", {
      type: "chunk",
      text: "second",
    });

    const page = await env.store.readPage(RUN, env.shared.FIRST_ID, 10);
    expect(page.events).toHaveLength(2);
    expect(
      page.events.map((event) => (event as { text: string }).text),
    ).toEqual(["first", "second"]);
  });

  it("mints a fresh id when the caller's id would go backwards", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-5", {
      type: "chunk",
      text: "later",
    });

    // Redis refuses a decreasing id with "equal or smaller". Rather than lose
    // the event, the backend retries with a minted id, so the stream stays
    // monotonic *and* nothing is dropped.
    await env.store.appendEvent(RUN, "1000-1", {
      type: "chunk",
      text: "earlier",
    });

    const page = await env.store.readPage(RUN, env.shared.FIRST_ID, 10);
    expect(
      page.events.map((event) => (event as { text: string }).text),
    ).toEqual(["later", "earlier"]);
    // The minted id is greater than the id it replaced.
    const ids = (
      (await env.redis.xrange(env.shared.streamKey(RUN), "-", "+")) as [
        string,
        string[],
      ][]
    ).map(([id]) => id);
    const [first, second] = ids;
    expect(env.shared.compareIds(second, first)).toBe(1);
  });
});

describe("eventStore — memory backend", () => {
  it("appends and reads without a Redis client", async () => {
    const mem = await bootMemory();
    try {
      await mem.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });
      await mem.store.appendEvent(RUN, "1000-1", { type: "chunk", text: "b" });

      const page = await mem.store.readPage(RUN, mem.shared.FIRST_ID, 10);

      expect(
        page.events.map((event) => (event as { text: string }).text),
      ).toEqual(["a", "b"]);
      expect(page.lastId).toBe("1000-1");
    } finally {
      await mem.store.dropStream(RUN);
      await mem.cleanup();
    }
  });

  it("respects the cursor and the count on the memory backend too", async () => {
    const mem = await bootMemory();
    try {
      for (let i = 0; i < 4; i++) {
        await mem.store.appendEvent(RUN, `1000-${String(i)}`, {
          type: "chunk",
          text: String(i),
        });
      }

      const page = await mem.store.readPage(RUN, "1000-1", 2);
      expect(
        page.events.map((event) => (event as { text: string }).text),
      ).toEqual(["2", "3"]);
    } finally {
      await mem.store.dropStream(RUN);
      await mem.cleanup();
    }
  });

  it("reports the last id and clears it on drop", async () => {
    const mem = await bootMemory();
    try {
      await mem.store.appendEvent(RUN, "1000-3", { type: "chunk", text: "a" });
      expect(await mem.store.lastStreamId(RUN)).toBe("1000-3");

      await mem.store.dropStream(RUN);
      expect(await mem.store.lastStreamId(RUN)).toBeUndefined();
    } finally {
      await mem.cleanup();
    }
  });

  it("wakes a waiting reader on the memory backend", async () => {
    const mem = await bootMemory();
    try {
      await mem.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

      const waiting = mem.store.waitForNext(RUN, "1000-0");
      setTimeout(() => {
        void mem.store.appendEvent(RUN, "1000-1", {
          type: "chunk",
          text: "b",
        });
      }, 100);

      const page = await waiting;
      expect(page?.events).toEqual([{ type: "chunk", text: "b" }]);
    } finally {
      await mem.store.dropStream(RUN);
      await mem.cleanup();
    }
  });
});
