import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredEvent } from "../../types/Chat.js";
import type { RunHandle } from "../types.js";

/**
 * `appendEvent` is the outbound Redis boundary. Mocking it lets the ordering
 * assertions below control how long each append takes, which is the only way to
 * tell an ordered queue from an unordered fire-and-forget loop.
 */
const appendEventMock = vi.hoisted(() =>
  vi.fn<(runId: string, eventId: string, event: unknown) => Promise<void>>(),
);

vi.mock("../eventStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appendEvent: appendEventMock,
}));

const {
  clearRuns,
  forgetRun,
  getRun,
  listRuns,
  listRunsForConversation,
  publish,
  pumpRun,
  registerRun,
  scheduleDisposal,
} = await import("../runRegistry.js");

/**
 * The registry is the only place a reader can attach to a detached run, so its
 * bookkeeping has to be exact: an event that is not published is not replayable,
 * and a run that is never forgotten leaks for the life of the process.
 */

function handle(partial: Partial<RunHandle> = {}): RunHandle {
  return {
    id: "run-1",
    kind: "workflow",
    startedAt: Date.now(),
    status: "running",
    events: [],
    eventIds: [],
    controller: new AbortController(),
    subscribers: new Set(),
    ...partial,
  };
}

beforeEach(() => {
  clearRuns();
  appendEventMock.mockReset();
  appendEventMock.mockResolvedValue(undefined);
});

afterEach(() => {
  clearRuns();
  vi.useRealTimers();
});

describe("registerRun and getRun", () => {
  it("stores the handle under its id, filling in the fields the registry owns", () => {
    const run = handle();
    const registered = registerRun(run);

    expect(registered.id).toBe("run-1");
    expect(registered.events).toStrictEqual([]);
    expect(registered.eventIds).toStrictEqual([]);
    expect(registered.controller).toBeInstanceOf(AbortController);
    expect(getRun("run-1")).toBe(registered);
  });

  it("returns undefined for an unknown id", () => {
    expect(getRun("missing")).toBeUndefined();
  });

  it("replaces a handle registered under the same id", () => {
    const first = registerRun(handle());
    const second = registerRun(handle());
    expect(getRun("run-1")).not.toBe(first);
    expect(getRun("run-1")).toBe(second);
  });

  it("forgets only the requested run", () => {
    registerRun(handle({ id: "a" }));
    const b = registerRun(handle({ id: "b" }));
    forgetRun("a");
    expect(getRun("a")).toBeUndefined();
    expect(getRun("b")).toBe(b);
  });
});

describe("listRuns", () => {
  it("returns every registered run", () => {
    registerRun(handle({ id: "a" }));
    registerRun(handle({ id: "b" }));
    expect(
      listRuns()
        .map((run) => run.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("is empty after a clear", () => {
    registerRun(handle());
    clearRuns();
    expect(listRuns()).toEqual([]);
  });
});

describe("listRunsForConversation", () => {
  it("filters by conversation id", () => {
    registerRun(handle({ id: "a", conversationId: 1 }));
    registerRun(handle({ id: "b", conversationId: 2 }));
    expect(listRunsForConversation(2).map((run) => run.id)).toEqual(["b"]);
  });

  it("excludes a run that has no conversation", () => {
    // A workflow run started without a conversation must not leak into any
    // conversation's list.
    registerRun(handle({ id: "a" }));
    expect(listRunsForConversation(1)).toEqual([]);
  });

  it("sorts newest first", () => {
    registerRun(handle({ id: "old", conversationId: 1, startedAt: 1_000 }));
    registerRun(handle({ id: "new", conversationId: 1, startedAt: 5_000 }));
    registerRun(handle({ id: "mid", conversationId: 1, startedAt: 3_000 }));
    expect(listRunsForConversation(1).map((run) => run.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });
});

describe("publish", () => {
  it("appends the event to the run's log", () => {
    const run = registerRun(handle());
    const event: StoredEvent = { type: "chunk", text: "hi" };
    publish(run, event);
    expect(run.events).toEqual([event]);
  });

  it("forwards the event and its id to every subscriber", () => {
    const run = registerRun(handle());
    const first = vi.fn();
    const second = vi.fn();
    run.subscribers.add(first);
    run.subscribers.add(second);
    const event: StoredEvent = { type: "chunk", text: "x" };
    publish(run, event);
    expect(first).toHaveBeenCalledWith(event, run.eventIds[0]);
    expect(second).toHaveBeenCalledWith(event, run.eventIds[0]);
  });

  it("drops a subscriber that throws, so one bad reader cannot stop the run", () => {
    const run = registerRun(handle());
    const broken = vi.fn(() => {
      throw new Error("socket closed");
    });
    const healthy = vi.fn();
    run.subscribers.add(broken);
    run.subscribers.add(healthy);
    publish(run, { type: "chunk", text: "a" });
    expect(run.subscribers.has(broken)).toBe(false);
    expect(run.subscribers.has(healthy)).toBe(true);
    // The next event must still reach the subscriber that survived.
    publish(run, { type: "chunk", text: "b" });
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it("keeps the log bounded, dropping the oldest events first", () => {
    const run = registerRun(handle());
    // The cap is 5000; publishing 5001 must leave the newest 5000.
    for (let i = 0; i <= 5_000; i++) {
      publish(run, { type: "chunk", text: String(i) });
    }
    expect(run.events).toHaveLength(5_000);
    expect(run.events[0]).toMatchObject({ text: "1" });
    expect(run.events.at(-1)).toMatchObject({ text: "5000" });
  });

  it("preserves order, which replay depends on", () => {
    const run = registerRun(handle());
    for (const text of ["a", "b", "c"]) publish(run, { type: "chunk", text });
    expect(run.events.map((event) => (event as { text: string }).text)).toEqual(
      ["a", "b", "c"],
    );
  });
});

describe("scheduleDisposal", () => {
  it("forgets the run after the retention window", () => {
    vi.useFakeTimers();
    const run = registerRun(handle());
    scheduleDisposal(run);
    expect(getRun("run-1")).toBe(run);
    vi.advanceTimersByTime(10 * 60 * 1000 - 1);
    expect(getRun("run-1")).toBe(run);
    vi.advanceTimersByTime(1);
    expect(getRun("run-1")).toBeUndefined();
  });

  it("cancels the pending disposal when the run is forgotten manually", () => {
    vi.useFakeTimers();
    const run = registerRun(handle());
    scheduleDisposal(run);
    run.disposal?.();
    expect(getRun("run-1")).toBeUndefined();
    // The timer would fire here if the disposal had not been cleared; it must
    // not resurrect the run or throw on a missing entry.
    expect(() => vi.advanceTimersByTime(10 * 60 * 1000)).not.toThrow();
  });

  it("clears every disposal on clearRuns", () => {
    vi.useFakeTimers();
    const run = registerRun(handle());
    scheduleDisposal(run);
    clearRuns();
    expect(() => vi.advanceTimersByTime(10 * 60 * 1000)).not.toThrow();
    expect(listRuns()).toEqual([]);
  });
});

/**
 * `publish` has two responsibilities beyond the in-memory log: mirror the event
 * into Redis, in order, and never let a Redis hiccup break the run. The append
 * queue is what makes the first possible — `XADD` is async while `emit` is not,
 * so unordered appends let a `chunk` land before the `tool_end` that preceded
 * it, and a reattaching client then replays a different story than the live one.
 */
describe("publish mirrors into Redis", () => {
  it("appends each event to the run's stream", async () => {
    const run = registerRun(handle({ id: "run-redis" }));

    publish(run, { type: "chunk", text: "one" });

    await vi.waitFor(() => {
      expect(appendEventMock).toHaveBeenCalledWith(
        "run-redis",
        run.eventIds[0],
        { type: "chunk", text: "one" },
      );
    });
  });

  it("keeps append order identical to publish order", async () => {
    const order: string[] = [];
    appendEventMock.mockImplementation(
      async (_runId: string, _eventId: string, event: unknown) => {
        // A slow first append is what would reorder a naive fire-and-forget loop.
        await new Promise((resolve) => {
          setTimeout(resolve, order.length === 0 ? 15 : 0);
        });
        order.push((event as { type: string }).type);
      },
    );

    const run = registerRun(handle({ id: "run-order" }));
    publish(run, { type: "tool_end" });
    publish(run, { type: "chunk", text: "a" });
    publish(run, { type: "chunk", text: "b" });

    await vi.waitFor(() => {
      expect(order).toHaveLength(3);
    });
    expect(order).toEqual(["tool_end", "chunk", "chunk"]);
  });

  it("drives the queue per run, so one slow run does not stall another", async () => {
    appendEventMock.mockImplementation(async (runId) => {
      if (runId === "run-slow") {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
    });

    const slow = registerRun(handle({ id: "run-slow" }));
    const fast = registerRun(handle({ id: "run-fast" }));

    publish(slow, { type: "chunk", text: "slow" });
    publish(fast, { type: "chunk", text: "fast" });

    await vi.waitFor(() => {
      expect(appendEventMock).toHaveBeenCalledWith(
        "run-fast",
        fast.eventIds[0],
        { type: "chunk", text: "fast" },
      );
    });
  });

  it("keeps the local log and subscribers working when Redis fails", async () => {
    appendEventMock.mockRejectedValue(new Error("redis is down"));
    const seen: string[] = [];
    const run = registerRun(handle({ id: "run-down" }));
    run.subscribers.add((event) => seen.push(event.type));

    publish(run, { type: "chunk", text: "survives" });

    // The stream is a cross-replica convenience, not the source of truth.
    expect(run.events).toHaveLength(1);
    expect(seen).toEqual(["chunk"]);
  });

  it("never rejects, so a fire-and-forget publish cannot become an unhandled rejection", async () => {
    appendEventMock.mockRejectedValue(new Error("redis is down"));
    const run = registerRun(handle({ id: "run-unhandled" }));

    publish(run, { type: "chunk", text: "x" });

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(appendEventMock).toHaveBeenCalled();
  });
});

/**
 * `pumpRun` is what makes a run outlive its HTTP response: the loop's lifetime
 * is the pump's, not the client's. It also owns the terminal state, so the paths
 * that must be right are the ones nobody watches — an abort, a throw, and a
 * persistence step that itself fails.
 */
describe("pumpRun", () => {
  function run(overrides: Partial<RunHandle> = {}): RunHandle {
    return registerRun(handle({ id: "pump-1", ...overrides }));
  }

  function args(
    overrides: Partial<Parameters<typeof pumpRun>[0]> = {},
  ): Parameters<typeof pumpRun>[0] {
    return {
      run: run(),
      agent: (async function* () {
        yield { type: "chunk", text: "hello" };
      })(),
      trace: { apply: vi.fn() } as never,
      log: { error: vi.fn() },
      persist: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it("publishes every agent event and a terminal done", async () => {
    const a = args();

    await pumpRun(a);

    expect(a.run.events.map((event) => event.type)).toEqual(["chunk", "done"]);
  });

  it("applies each event to the trace", async () => {
    const apply = vi.fn<(...args: unknown[]) => void>();
    const a = args({ trace: { apply } as never });

    await pumpRun(a);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ type: "chunk", text: "hello" });
  });

  it("marks the run finished and persists that status", async () => {
    const a = args();

    await pumpRun(a);

    expect(a.run.status).toBe("finished");
    expect(a.persist).toHaveBeenCalledWith("finished", undefined);
  });

  it("marks the run failed and publishes an error frame on a throw", async () => {
    const a = args({
      agent: (async function* () {
        yield { type: "chunk", text: "partial" };
        throw new Error("agent exploded");
      })(),
    });

    await pumpRun(a);

    expect(a.run.status).toBe("failed");
    expect(a.run.events.map((event) => event.type)).toEqual(["chunk", "error"]);
  });

  it("keeps the events emitted before the failure", async () => {
    const a = args({
      agent: (async function* () {
        yield { type: "chunk", text: "partial" };
        throw new Error("boom");
      })(),
    });

    await pumpRun(a);

    // A client that reattaches must still see what the agent managed to say.
    expect(a.run.events[0]).toEqual({ type: "chunk", text: "partial" });
  });

  it("persists the failure message, not the generic client text", async () => {
    const a = args({
      agent: (async function* () {
        throw new Error("the real reason");
      })(),
    });

    await pumpRun(a);

    expect(a.persist).toHaveBeenCalledWith("failed", "the real reason");
  });

  it("never leaks the internal error message to the client", async () => {
    const a = args({
      agent: (async function* () {
        throw new Error("connection string leaked here");
      })(),
    });

    await pumpRun(a);

    const frame = a.run.events.at(-1);
    expect(JSON.stringify(frame)).not.toContain("connection string");
  });

  it("logs the failure with the run id", async () => {
    const a = args({
      agent: (async function* () {
        throw new Error("boom");
      })(),
    });

    await pumpRun(a);

    expect(a.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "pump-1" }),
      "Agent failure during detached run",
    );
  });

  it("treats an aborted signal as aborted, not failed", async () => {
    const handleWithSignal = handle({ id: "pump-abort" });
    handleWithSignal.controller.abort();
    const a = args({
      run: registerRun(handleWithSignal),
      agent: (async function* () {
        throw new Error("AbortError");
      })(),
    });

    await pumpRun(a);

    // A user pressing stop must not be recorded as a crash.
    expect(a.run.status).toBe("aborted");
    expect(a.persist).toHaveBeenCalledWith("aborted", undefined);
  });

  it("publishes done rather than error when the run was aborted", async () => {
    const handleWithSignal = handle({ id: "pump-abort-2" });
    handleWithSignal.controller.abort();
    const a = args({
      run: registerRun(handleWithSignal),
      agent: (async function* () {
        throw new Error("AbortError");
      })(),
    });

    await pumpRun(a);

    expect(a.run.events.at(-1)).toEqual({ type: "done" });
  });

  it("persists the terminal status even when persistence throws", async () => {
    const a = args({
      persist: vi.fn(async () => {
        throw new Error("database is down");
      }),
    });

    await expect(pumpRun(a)).resolves.toBeUndefined();

    expect(a.run.status).toBe("finished");
    expect(a.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "pump-1" }),
      "Failed to persist the finished run",
    );
  });

  it("schedules disposal so a finished run is eventually forgotten", async () => {
    vi.useFakeTimers();
    try {
      const a = args();
      await pumpRun(a);
      expect(getRun("pump-1")?.id).toBe("pump-1");

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);

      expect(getRun("pump-1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles an agent that yields nothing", async () => {
    const a = args({
      agent: (async function* () {
        // A tool-free run whose provider produced no text.
      })(),
    });

    await pumpRun(a);

    expect(a.run.events).toEqual([{ type: "done" }]);
    expect(a.run.status).toBe("finished");
  });
});

describe("pumpRun with a non-Error rejection", () => {
  it("stringifies whatever was thrown, so persistence still records a reason", async () => {
    const run = registerRun(
      handle({
        id: "pump-nonerror",
        startedAt: Date.now(),
        status: "running",
        events: [],
        controller: new AbortController(),
        subscribers: new Set(),
      }),
    );
    const persist = vi.fn(async () => {});

    await pumpRun({
      run,
      // Providers and libraries reject with non-Error values; the loop must not
      // assume `instanceof Error` or persistence would lose the reason.
      agent: (async function* () {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the bare value is the point
        await Promise.reject("a bare string");
        yield { type: "done" } as never;
      })(),
      trace: { apply: vi.fn() } as never,
      log: { error: vi.fn() },
      persist,
    });

    expect(persist).toHaveBeenCalledWith("failed", "a bare string");
  });
});
