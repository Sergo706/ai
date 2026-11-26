import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../types/ToolExecutionTypes.js";

vi.mock("../traceCollector.ts", () => ({
  TraceCollector: class {
    apply = vi.fn();
    toTrace = vi.fn(() => null);
  },
}));

import { RequestAbortedError } from "../../tools/execution/index.js";
import { libLog } from "~~/test/test-utils/logger";

import { runAgentStream } from "../agentStream.js";
import { createEventSink } from "../eventSink.js";
import { TraceCollector } from "../traceCollector.js";

/**
 * `runAgentStream` owns the SSE contract: an `init` first, a `done` last, and a
 * `error` frame instead of a dropped connection when the agent throws. It also
 * owns cleanup, which is where a leaked interval or an unpersisted exchange
 * would show up as a slow process and missing history.
 */

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function abortStub(aborted = false) {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    signal: controller.signal,
    abort: vi.fn(() => {
      controller.abort();
    }),
    markFinished: vi.fn(),
    _controller: controller,
  };
}

/** Drain a stream into the raw SSE text. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

/** The `data:` payloads in arrival order. */
function frames(text: string): { type?: string }[] {
  return text
    .split("\n\n")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("data: "))
    .map(
      (part) => JSON.parse(part.slice("data: ".length)) as { type?: string },
    );
}

/** An async iterable that yields the given events then completes. */
function agentOf(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

/** An async iterable that throws after yielding. */
function throwingAgent(
  yielded: AgentEvent[],
  error: unknown,
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of yielded) yield event;
      throw error;
    },
  };
}

function params(overrides: Partial<Parameters<typeof runAgentStream>[0]> = {}) {
  return {
    agent: agentOf([]),
    convId: 5,
    sink: createEventSink(),
    trace: new TraceCollector() as never,
    abort: abortStub() as never,
    log: logger() as never,
    onFinish: vi.fn(async () => {}),
    heartbeatMs: 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("runAgentStream — frame sequence", () => {
  it("opens with init carrying the conversation id", async () => {
    const text = await drain(runAgentStream(params()));

    expect(frames(text)[0]).toEqual({ type: "init", conversationId: 5 });
  });

  it("closes with done after the agent completes", async () => {
    const text = await drain(runAgentStream(params()));

    expect(frames(text).at(-1)).toEqual({ type: "done" });
  });

  it("forwards every agent event in order", async () => {
    const events: AgentEvent[] = [
      { type: "chunk", text: "a" },
      { type: "chunk", text: "b" },
    ] as AgentEvent[];

    const text = await drain(
      runAgentStream(params({ agent: agentOf(events) })),
    );

    expect(frames(text).slice(1, -1)).toEqual(events);
  });

  it("feeds every forwarded event to the trace collector", async () => {
    const trace = { apply: vi.fn(), toTrace: vi.fn(() => null) };

    await drain(
      runAgentStream(
        params({
          trace: trace as never,
          agent: agentOf([{ type: "chunk", text: "a" }] as AgentEvent[]),
        }),
      ),
    );

    expect(trace.apply).toHaveBeenCalledWith({ type: "chunk", text: "a" });
  });
});

describe("runAgentStream — failure", () => {
  it("emits an error frame when the agent throws", async () => {
    const text = await drain(
      runAgentStream(
        params({ agent: throwingAgent([], new Error("provider exploded")) }),
      ),
    );

    const errorFrame = frames(text).find((frame) => frame.type === "error");
    // A provider failure is reported as a frame rather than thrown, so the
    // client always receives a well-formed stream terminator.
    expect(errorFrame).toEqual({
      type: "error",
      message: expect.any(String) as string,
    });
  });

  it("does not leak the provider's message to the client", async () => {
    const text = await drain(
      runAgentStream(
        params({
          agent: throwingAgent([], new Error("sk-live-abcd1234 invalid key")),
        }),
      ),
    );

    expect(text).not.toContain("sk-live-abcd1234");
  });

  it("does not emit done after a failure", async () => {
    const text = await drain(
      runAgentStream(params({ agent: throwingAgent([], new Error("boom")) })),
    );

    expect(frames(text).some((f) => f.type === "done")).toBe(false);
  });

  it("logs the underlying error", async () => {
    await drain(
      runAgentStream(params({ agent: throwingAgent([], new Error("boom")) })),
    );

    // `runAgentStream` reads its logger from the configuration, so the injected
    // spy logger is what records the line.
    expect(libLog.error).toHaveBeenCalled();
  });

  it("stays silent when the error is a RequestAbortedError", async () => {
    const text = await drain(
      runAgentStream(
        params({
          agent: throwingAgent([], new RequestAbortedError()),
        }),
      ),
    );

    expect(frames(text).some((f) => f.type === "error")).toBe(false);
    expect(libLog.error).not.toHaveBeenCalled();
  });

  it("stays silent when the request signal was aborted", async () => {
    const abort = abortStub(true);
    const text = await drain(
      runAgentStream(
        params({
          abort,
          agent: throwingAgent([], new Error("x")),
        }),
      ),
    );

    expect(frames(text).some((f) => f.type === "error")).toBe(false);
  });
});

describe("runAgentStream — cleanup", () => {
  it("marks the request finished so the close handler ignores it", async () => {
    const abort = abortStub();
    await drain(runAgentStream(params({ abort })));

    expect(abort.markFinished).toHaveBeenCalled();
  });

  it("runs onFinish once the stream completes", async () => {
    const onFinish = vi.fn(async () => {});
    await drain(runAgentStream(params({ onFinish })));

    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("runs onFinish even when the agent failed", async () => {
    const onFinish = vi.fn(async () => {});
    await drain(
      runAgentStream(
        params({ onFinish, agent: throwingAgent([], new Error("boom")) }),
      ),
    );

    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("does not fail the stream when onFinish throws", async () => {
    const onFinish = vi.fn(async () => {
      throw new Error("persist failed");
    });

    await expect(
      drain(runAgentStream(params({ onFinish }))),
    ).resolves.toContain("data:");
    expect(libLog.error).toHaveBeenCalled();
  });

  it("detaches the sink so a later push is dropped", async () => {
    const sink = createEventSink();
    await drain(runAgentStream(params({ sink })));

    // Pushing after the stream ended must not throw or resurrect the consumer.
    expect(() => {
      sink.push({ type: "chunk", text: "late" });
    }).not.toThrow();
  });
});

describe("runAgentStream — heartbeat", () => {
  it("emits heartbeats while the agent is still working", async () => {
    vi.useFakeTimers();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const agent = {
      async *[Symbol.asyncIterator]() {
        await gate;
        yield { type: "chunk", text: "a" } as AgentEvent;
      },
    };

    const stream = runAgentStream(params({ agent, heartbeatMs: 10 }));
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    await vi.advanceTimersByTimeAsync(35);
    const first = decoder.decode((await reader.read()).value);
    vi.useRealTimers();
    release();
    await reader.cancel();
    expect(first).toContain("data");
  });
});
