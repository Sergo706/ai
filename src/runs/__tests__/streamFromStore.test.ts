import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TailRunParams } from "../types.js";

/**
 * `streamFromStore` is the cross-replica attach path: it renders whatever
 * `tailRun` hands back and decides when the response closes.
 *
 * `tailRun` is replaced rather than the Redis client because that is the seam
 * the function actually sits on — the store's own replay/tail mechanics are
 * covered in `eventStore.test.ts`. What is left to test here is the SSE
 * encoding, the close conditions, and the `isRunAlive` hand-off that lets a
 * reader survive the replica holding the run.
 */

const storeMock = vi.hoisted(() => ({
  tailRun: vi.fn<(params: TailRunParams) => () => void>(),
  FIRST_ID: "0-0",
}));

vi.mock("../eventStore", () => ({
  tailRun: storeMock.tailRun,
  FIRST_ID: storeMock.FIRST_ID,
}));

const { streamFromStore } = await import("../streamFromStore.js");

const log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

/**
 * The `tailRun` params captured for one call.
 *
 * `streamFromStore` starts the reader inside the stream's `start()`, so the
 * params only exist after the stream has been constructed.
 */
function captured(call = 0): TailRunParams {
  return storeMock.tailRun.mock.calls[call][0];
}

/**
 * Reads every frame already queued without waiting for `done`.
 *
 * A live stream stays open on purpose; a drain that waited for `done` would
 * hang until the test timeout.
 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const next = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => {
          setTimeout(() => {
            resolve(null);
          }, 5);
        }),
      ]);
      if (next === null || next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return text;
}

function parse(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .flatMap((block) => {
      // A frame carries an `id:` line before `data:` when the event has a
      // stream id, so extract the data line rather than matching the whole block.
      const data = block
        .split("\n")
        .find((line) => line.startsWith("data: "));
      return data === undefined
        ? []
        : [JSON.parse(data.slice("data: ".length)) as Record<string, unknown>];
    });
}

function params(
  overrides: Partial<Parameters<typeof streamFromStore>[0]> = {},
) {
  return {
    runId: "run-1",
    log,
    isRunAlive: async () => true,
    ...overrides,
  };
}

beforeEach(() => {
  storeMock.tailRun.mockReset();
  storeMock.tailRun.mockReturnValue(() => {});
});

describe("streamFromStore", () => {
  describe("attaching", () => {
    it("tails the requested run", () => {
      const stream = streamFromStore(params());

      void drain(stream);

      expect(captured().runId).toBe("run-1");
    });

    it("replays from the beginning when no cursor is given", () => {
      void drain(streamFromStore(params()));

      // A fresh reader must see the whole run, not just what happens next.
      expect(captured().afterId).toBe("0-0");
    });

    it("resumes after the client's cursor", () => {
      void drain(streamFromStore(params({ since: "1700000000000-3" })));

      // The cursor is a stream id, so a reconnecting client gets exactly the
      // events after the last one it saw, even across a replica change.
      expect(captured().afterId).toBe("1700000000000-3");
    });

    it("logs the attach with the cursor it used", () => {
      const logger = {
        debug: vi.fn(),
        info: () => {},
        warn: () => {},
        error: () => {},
      };

      void drain(
        streamFromStore(params({ since: "5-0", log: logger as never })),
      );

      expect(logger.debug).toHaveBeenCalledWith(
        { runId: "run-1", since: "5-0" },
        "[runs] Attached a reader through the event store",
      );
    });
  });

  describe("frames", () => {
    it("sends an init frame when the caller passed a conversation", async () => {
      const stream = streamFromStore(params({ conversationId: 42 }));

      expect(parse(await drain(stream))[0]).toMatchObject({
        type: "init",
        conversationId: 42,
        runId: "run-1",
      });
    });

    it("omits the init frame when there is no conversation", async () => {
      const stream = streamFromStore(params());

      expect(parse(await drain(stream))).toEqual([]);
    });

    it("writes every event the store delivers", async () => {
      storeMock.tailRun.mockImplementation((tail) => {
        tail.onEvent({ type: "chunk", text: "hello" }, "1-0");
        tail.onEvent({ type: "chunk", text: " world" }, "1-0");
        return () => {};
      });

      const frames = parse(await drain(streamFromStore(params())));

      expect(frames).toEqual([
        { type: "chunk", text: "hello" },
        { type: "chunk", text: " world" },
      ]);
    });

    it("formats each frame as an SSE data line", async () => {
      const stream = streamFromStore(params({ conversationId: 1 }));

      expect(await drain(stream)).toContain('data: {"type":"init"');
    });

    it("stops writing once a done event arrives", async () => {
      storeMock.tailRun.mockImplementation((tail) => {
        tail.onEvent({ type: "done" }, "1-0");
        // A store that keeps pushing after `done` must not reach the client.
        tail.onEvent({ type: "chunk", text: "too late" }, "1-0");
        return () => {};
      });

      const frames = parse(await drain(streamFromStore(params())));

      expect(frames).toEqual([{ type: "done" }]);
    });

    it("stops writing once an error event arrives", async () => {
      storeMock.tailRun.mockImplementation((tail) => {
        tail.onEvent({ type: "error", message: "boom" }, "1-0");
        tail.onEvent({ type: "chunk", text: "too late" }, "1-0");
        return () => {};
      });

      const frames = parse(await drain(streamFromStore(params())));

      expect(frames).toEqual([{ type: "error", message: "boom" }]);
    });
  });

  describe("closing when the run ends", () => {
    it("closes the stream after a done event", async () => {
      storeMock.tailRun.mockImplementation((tail) => {
        tail.onEvent({ type: "done" }, "1-0");
        return () => {};
      });

      const reader = streamFromStore(params()).getReader();
      await reader.read();
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
    });

    it("closes the stream after an error event", async () => {
      storeMock.tailRun.mockImplementation((tail) => {
        tail.onEvent({ type: "error", message: "boom" }, "1-0");
        return () => {};
      });

      const reader = streamFromStore(params()).getReader();
      await reader.read();
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
    });

    it("reports idle so the store stops polling a finished run", async () => {
      let idleResult: boolean | undefined;
      storeMock.tailRun.mockImplementation((tail) => {
        void tail.onIdle?.().then((result) => {
          idleResult = result;
        });
        return () => {};
      });

      const stream = streamFromStore(params({ isRunAlive: async () => false }));
      await drain(stream);
      await vi.waitFor(() => {
        expect(idleResult).toBe(true);
      });

      // `true` tells `tailRun` it can stop; the stream already sent `done`.
      expect(idleResult).toBe(true);
    });

    it("stays open while the run is still alive", async () => {
      let idleResult: boolean | undefined;
      storeMock.tailRun.mockImplementation((tail) => {
        void tail.onIdle?.().then((result) => {
          idleResult = result;
        });
        return () => {};
      });

      const stream = streamFromStore(params({ isRunAlive: async () => true }));
      await drain(stream);
      await vi.waitFor(() => {
        expect(idleResult).toBe(false);
      });

      expect(idleResult).toBe(false);
    });

    it("sends a done frame before closing an idle stream", async () => {
      storeMock.tailRun.mockImplementation((tail) => {
        void tail.onIdle?.();
        return () => {};
      });

      const frames = parse(
        await drain(streamFromStore(params({ isRunAlive: async () => false }))),
      );

      // A client that only ever sees silence cannot tell that the replica
      // holding its run died, so this frame is what ends the reload spinner.
      expect(frames).toContainEqual({ type: "done" });
    });

    it("does not duplicate done when the run also ended normally", async () => {
      storeMock.tailRun.mockImplementation((tail) => {
        tail.onEvent({ type: "done" }, "1-0");
        void tail.onIdle?.();
        return () => {};
      });

      const frames = parse(
        await drain(streamFromStore(params({ isRunAlive: async () => false }))),
      );

      expect(frames.filter((frame) => frame.type === "done")).toHaveLength(1);
    });
  });

  describe("heartbeats", () => {
    it("writes a heartbeat comment on the configured interval", async () => {
      vi.useFakeTimers();
      try {
        const stream = streamFromStore(params({ heartbeatMs: 1_000 }));
        const reader = stream.getReader();

        await vi.advanceTimersByTimeAsync(1_000);
        const chunk = await reader.read();

        expect(new TextDecoder().decode(chunk.value)).toBe(": heartbeat\n\n");
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops heartbeating once the stream closed", async () => {
      vi.useFakeTimers();
      try {
        storeMock.tailRun.mockImplementation((tail) => {
          tail.onEvent({ type: "done" }, "1-0");
          return () => {};
        });
        const reader = streamFromStore(
          params({ heartbeatMs: 1_000 }),
        ).getReader();
        await reader.read();
        await reader.read();
        expect((await reader.read()).done).toBe(true);

        // A heartbeat enqueued after `close()` would throw inside the timer.
        await vi.advanceTimersByTimeAsync(5_000);
        reader.releaseLock();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("detaching", () => {
    it("uses the store's stop function when the client cancels", async () => {
      const stop = vi.fn();
      storeMock.tailRun.mockReturnValue(stop);

      const reader = streamFromStore(params()).getReader();
      await reader.cancel();

      expect(stop).toHaveBeenCalled();
    });

    it("does not abort the run when the reader detaches", async () => {
      const abort = vi.fn();
      const stream = streamFromStore(params());
      const reader = stream.getReader();

      await reader.cancel();

      // Detaching a reader must never stop the work; that is the whole point
      // of a detached run.
      expect(abort).not.toHaveBeenCalled();
    });

    it("still closes the stream when the client already went away", async () => {
      storeMock.tailRun.mockImplementation((tail) => {
        tail.onEvent({ type: "done" }, "1-0");
        return () => {};
      });

      const reader = streamFromStore(params()).getReader();
      await reader.cancel();

      // Cancelling twice must not throw: `close()` is guarded.
      await expect(reader.closed).resolves.toBeUndefined();
      reader.releaseLock();
    });
  });
});

/**
 * The two remaining paths are both about a client that has already gone away.
 * They are easy to leave uncovered and impossible to reason about later, because
 * a throw inside the `start()` callback of a `ReadableStream` is not surfaced to
 * anyone — it just stops the response mid-run.
 */
describe("streamFromStore with a closed client", () => {
  it("reports closed to the store so it stops delivering events", async () => {
    let stopResult: boolean | undefined;
    storeMock.tailRun.mockImplementation((tail) => {
      stopResult = tail.shouldStop();
      return () => {};
    });

    await drain(streamFromStore(params()));

    expect(stopResult).toBe(false);
  });

  it("reports closed after a terminal event", async () => {
    let stopAfter: boolean | undefined;
    storeMock.tailRun.mockImplementation((tail) => {
      tail.onEvent({ type: "done" }, "1-0");
      stopAfter = tail.shouldStop();
      return () => {};
    });

    await drain(streamFromStore(params()));

    // A store that kept polling here would hold a dead task open.
    expect(stopAfter).toBe(true);
  });

  it("survives an enqueue that throws because the client disconnected", async () => {
    let capturedTail: TailRunParams | undefined;
    storeMock.tailRun.mockImplementation((tail) => {
      capturedTail = tail;
      return () => {};
    });

    const reader = streamFromStore(params()).getReader();
    await reader.cancel();

    // Enqueueing to a cancelled controller throws; the guard must absorb it
    // instead of letting it escape into the stream's start() callback.
    expect(() => {
      capturedTail?.onEvent({ type: "chunk", text: "late" }, "1-0");
    }).not.toThrow();
    reader.releaseLock();
  });
});
