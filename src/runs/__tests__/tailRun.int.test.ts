import { afterEach, describe, expect, it } from "vitest";

import { INTEGRATION_REDIS_URL } from "~~/test/integration.setup.js";
import { libLogger, resetLibLogger } from "~~/test/test-utils/logger.js";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config.js";
import type { TailRunParams } from "~/runs/types.js";

/**
 * The replay-then-tail loop, against a real Redis stream.
 *
 * `tailRun` is what a reconnecting client actually pulls from, so the ordering
 * guarantees it makes — no skip, no duplicate, stop exactly on `done` — are
 * asserted against the real backend rather than against the in-process arrays.
 */

type EventStore = typeof import("~/runs/eventStore/index.js");
type Shared = typeof import("~/runs/eventStore/shared.js");

const RUN = "run-tail-1";

interface Harness {
  store: EventStore;
  shared: Shared;
  redis: NonNullable<LoadedConfig["redis"]>;
  cleanup: () => Promise<void>;
}

let env: Harness | undefined;

async function bootRedis(): Promise<Harness> {
  resetLibLogger();
  const loaded = await loadConfig({ redisUrl: INTEGRATION_REDIS_URL, logger: libLogger });
  if (!loaded.redis) throw new Error("Expected a real Redis client");

  const store = (await import("~/runs/eventStore/index.js"));
  const shared = (await import("~/runs/eventStore/shared.js"));
  await loaded.redis.del(shared.streamKey(RUN));

  return {
    store,
    shared,
    redis: loaded.redis,
    cleanup: async () => {
      await loaded.redis?.del(shared.streamKey(RUN));
      await loaded.cleanup();
    },
  };
}

async function bootMemory(): Promise<Omit<Harness, "redis">> {
  resetLibLogger();
  const loaded = await loadConfig({ logger: libLogger });
  const store = (await import("~/runs/eventStore/index.js"));
  const shared = (await import("~/runs/eventStore/shared.js"));
  return {
    store,
    shared,
    cleanup: async () => {
      await store.dropStream(RUN);
      await loaded.cleanup();
    },
  };
}

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

/**
 * Collects what a tail delivers, resolving once it reports `settled`.
 *
 * `tailRun` is fire-and-forget by design (it returns only a stop function), so
 * the test drives it through callbacks and waits on a promise.
 */
function collect(
  tail: (params: TailRunParams) => () => void,
  args: {
    afterId?: string;
    onIdle?: () => Promise<boolean>;
    stopAfter?: number;
  } = {},
): {
  events: { type: string; text?: string }[];
  ids: string[];
  settled: Promise<void>;
  errors: unknown[];
  stop: () => void;
} {
  const events: { type: string; text?: string }[] = [];
  const ids: string[] = [];
  const errors: unknown[] = [];
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });

  let stopped = false;
  const stop = tail({
    runId: RUN,
    ...(args.afterId === undefined ? {} : { afterId: args.afterId }),
    onEvent: (event, id) => {
      events.push(event);
      ids.push(id);
      // `tailRun` detaches itself on `done`/`error` without telling the caller,
      // so the collector has to recognise the terminator and resolve.
      if (event.type === "done" || event.type === "error") {
        stopped = true;
        finish();
        return;
      }
      if (args.stopAfter !== undefined && events.length >= args.stopAfter) {
        stopped = true;
        finish();
      }
    },
    shouldStop: () => stopped,
    ...(args.onIdle === undefined ? {} : { onIdle: args.onIdle }),
    onError: (err) => {
      errors.push(err);
      finish();
    },
    log: libLogger,
  });

  return {
    events,
    ids,
    settled,
    errors,
    stop: () => {
      stopped = true;
      stop();
      finish();
    },
  };
}

describe("tailRun — real Redis", () => {
  it("replays existing events and then stops on done", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });
    await env.store.appendEvent(RUN, "1000-1", { type: "chunk", text: "b" });
    await env.store.appendEvent(RUN, "1000-2", { type: "done" });

    const run = collect(env.store.tailRun);
    await run.settled;

    expect(run.events).toEqual([
      { type: "chunk", text: "a" },
      { type: "chunk", text: "b" },
      { type: "done" },
    ]);
    expect(run.ids).toEqual(["1000-0", "1000-1", "1000-2"]);
    expect(run.errors).toEqual([]);
  });

  it("stops on an error frame as well as on done", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "error" });

    const run = collect(env.store.tailRun);
    await run.settled;
    expect(run.events).toEqual([{ type: "error" }]);
  });

  it("resumes strictly after the cursor it was given", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });
    await env.store.appendEvent(RUN, "1000-1", { type: "chunk", text: "b" });
    await env.store.appendEvent(RUN, "1000-2", { type: "done" });

    const run = collect(env.store.tailRun, { afterId: "1000-0" });
    await run.settled;

    // The cursor event itself is not replayed.
    expect(run.events).toEqual([
      { type: "chunk", text: "b" },
      { type: "done" },
    ]);
  });

  it("waits for live events after the replay is exhausted", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    const run = collect(env.store.tailRun);

    // Let the replay finish, then publish the rest.
    setTimeout(() => {
      void (async () => {
        await env?.store.appendEvent(RUN, "1000-1", { type: "chunk", text: "live" });
        await env?.store.appendEvent(RUN, "1000-2", { type: "done" });
      })();
    }, 150);

    await run.settled;

    expect(run.events).toEqual([
      { type: "chunk", text: "a" },
      { type: "chunk", text: "live" },
      { type: "done" },
    ]);
  }, 20_000);

  it("calls onIdle when the block window expires with nothing new", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    let idleCalls = 0;
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const events: unknown[] = [];
    let stopped = false;

    env.store.tailRun({
      runId: RUN,
      onEvent: (event) => events.push(event),
      shouldStop: () => stopped,
      onIdle: () => {
        idleCalls += 1;
        stopped = true;
        finish();
        return Promise.resolve(true);
      },
      log: libLogger,
    });

    await settled;

    // One idle round means the reader saw an empty block and handed control
    // back, which is exactly the moment it should ask whether to stop.
    expect(idleCalls).toBe(1);
    expect(events).toEqual([{ type: "chunk", text: "a" }]);
  }, 25_000);

  it("keeps tailing when onIdle says false", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    let idleCalls = 0;
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let stopped = false;

    env.store.tailRun({
      runId: RUN,
      onEvent: () => undefined,
      shouldStop: () => stopped,
      onIdle: () => {
        idleCalls += 1;
        // Stay attached for one extra round, then detach.
        if (idleCalls < 2) return Promise.resolve(false);
        stopped = true;
        finish();
        return Promise.resolve(true);
      },
      log: libLogger,
    });

    await settled;
    expect(idleCalls).toBe(2);
  }, 45_000);

  it("stops immediately when shouldStop is already true", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    let calls = 0;
    const events: unknown[] = [];
    env.store.tailRun({
      runId: RUN,
      onEvent: (event) => events.push(event),
      shouldStop: () => {
        calls += 1;
        return true;
      },
      log: libLogger,
    });

    // Give the async body a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toBe(1);
    expect(events).toEqual([]);
  });

  it("reports a failure through onError and the log", async () => {
    env = await bootRedis();
    await env.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    // A read against a dropped connection is the realistic failure; closing the
    // client makes the next call reject.
    const errors: unknown[] = [];
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });

    env.redis.disconnect();
    env.store.tailRun({
      runId: RUN,
      onEvent: () => undefined,
      shouldStop: () => false,
      onError: (err) => {
        errors.push(err);
        finish();
      },
      log: libLogger,
    });

    await settled;
    expect(errors).toHaveLength(1);

    // Reconnect so `afterEach` cleanup does not fail.
    await env.redis.connect();
  }, 20_000);
});

describe("tailRun — memory backend", () => {
  it("replays from memory and stops on done", async () => {
    const mem = await bootMemory();
    env = { ...mem, redis: undefined as never };
    await mem.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });
    await mem.store.appendEvent(RUN, "1000-1", { type: "done" });

    const run = collect(mem.store.tailRun);
    await run.settled;
    expect(run.events).toEqual([
      { type: "chunk", text: "a" },
      { type: "done" },
    ]);
  });

  it("delivers a live append on the memory backend", async () => {
    const mem = await bootMemory();
    env = { ...mem, redis: undefined as never };
    await mem.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    const run = collect(mem.store.tailRun);
    setTimeout(() => {
      void mem.store.appendEvent(RUN, "1000-1", { type: "done" });
    }, 100);

    await run.settled;
    expect(run.events).toEqual([
      { type: "chunk", text: "a" },
      { type: "done" },
    ]);
  }, 20_000);
});

describe("memory backend branches", () => {
  it("trims the oldest entries past the stream cap", async () => {
    const mem = await bootMemory();
    env = { ...mem, redis: undefined as never };
    const cap = mem.shared.MAX_STREAM_LEN;

    // One past the cap, so exactly one entry must fall off the front.
    for (let i = 0; i <= cap; i += 1) {
      await mem.store.appendEvent(RUN, `1000-${String(i)}`, {
        type: "chunk",
        text: String(i),
      });
    }

    const page = await mem.store.readPage(RUN, mem.shared.FIRST_ID, cap + 10);
    expect(page.events).toHaveLength(cap);
    // The very first event was dropped; the second one is now at the front.
    expect(page.events[0]).toEqual({ type: "chunk", text: "1" });
  }, 20_000);

  it("refreshes the TTL without changing the events", async () => {
    const mem = await bootMemory();
    env = { ...mem, redis: undefined as never };
    await mem.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    await mem.store.touchStream(RUN);

    const page = await mem.store.readPage(RUN, mem.shared.FIRST_ID, 10);
    expect(page.events).toEqual([{ type: "chunk", text: "a" }]);
  });

  it("touches a run that was never written without creating one", async () => {
    const mem = await bootMemory();
    env = { ...mem, redis: undefined as never };

    await mem.store.touchStream("run-never-written");

    expect(await mem.store.lastStreamId("run-never-written")).toBeUndefined();
    const page = await mem.store.readPage("run-never-written", mem.shared.FIRST_ID, 10);
    expect(page.events).toEqual([]);
  });

  it("returns null when a memory read blocks and nothing arrives", async () => {
    const mem = await bootMemory();
    env = { ...mem, redis: undefined as never };
    await mem.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    // The event already exists, so this is the non-blocking path...
    expect(
      (await mem.store.waitForNext(RUN, "999-0"))?.events,
    ).toHaveLength(1);

    // ...and this one must block for the whole window and then give up.
    const started = Date.now();
    const page = await mem.store.waitForNext(RUN, "1000-0");
    expect(page).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(
      Math.max(1_000, mem.shared.BLOCK_MS) - 100,
    );
  }, 20_000);

  it("returns null from a blocking wait when the run has no log at all", async () => {
    const mem = await bootMemory();
    env = { ...mem, redis: undefined as never };
    expect(await mem.store.waitForNext("run-never-written", "0-0")).toBeNull();
  });

  it("wakes a blocked reader when the log is dropped", async () => {
    const mem = await bootMemory();
    env = { ...mem, redis: undefined as never };
    await mem.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });

    const waiting = mem.store.waitForNext(RUN, "1000-0");
    setTimeout(() => {
      void mem.store.dropStream(RUN);
    }, 100);

    // Dropping the log notifies the waiters, which find nothing new and return
    // null rather than hanging until the block expires.
    expect(await waiting).toBeNull();
  }, 20_000);

  it("starts a cursor past the end at the beginning rather than guessing", async () => {
    const mem = await bootMemory();
    env = { ...mem, redis: undefined as never };
    await mem.store.appendEvent(RUN, "1000-0", { type: "chunk", text: "a" });
    await mem.store.appendEvent(RUN, "1000-1", { type: "chunk", text: "b" });

    // A cursor the trimmed log no longer holds replays from the oldest entry,
    // matching what Redis does for an id it has evicted.
    const page = await mem.store.readPage(RUN, "999-9", 10);
    expect(page.events).toEqual([
      { type: "chunk", text: "a" },
      { type: "chunk", text: "b" },
    ]);
  });

  it("returns the cursor unchanged for an empty read of an unknown run", async () => {
    const mem = await bootMemory();
    env = { ...mem, redis: undefined as never };
    const page = await mem.store.readPage("run-never-written", "1000-7", 10);
    expect(page).toEqual({ ids: [], events: [], lastId: "1000-7" });
  });
});
