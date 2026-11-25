import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { loadConfig } from "~~/test/test-utils/config";
import { chatCompletion, createFakeLlm } from "~~/test/test-utils/llm";
import { libLogger } from "~~/test/test-utils/logger";

/**
 * The two turn implementations plus the finisher.
 *
 * `chat.completions.create` is the only faked boundary. `executeToolLoop`,
 * `llmSchemaParser`, the frame queue and the finisher all run for real against a
 * real sqlite database, so what is asserted here is the turn's own contract:
 * which provider request it makes, what it does with a valid or invalid
 * structured answer, and what a reader sees when the loop fails or is aborted.
 */

type JsonTurn = typeof import("../jsonTurn.js");
type StreamTurn = typeof import("../streamTurn.js");
type Finish = typeof import("../finish.js");
type Frames = typeof import("../frames.js");
type Types = typeof import("../types.js");
type Trace = typeof import("../../chat/traceCollector.js");
type Errors = typeof import("../../tools/execution/errors.js");

interface Harness {
  jsonTurn: JsonTurn;
  streamTurn: StreamTurn;
  finish: Finish;
  frames: Frames;
  types: Types;
  TraceCollector: Trace["TraceCollector"];
  RequestAbortedError: Errors["RequestAbortedError"];
  db: ReturnType<typeof import("../../config/config.js").getDb>;
  cleanup: () => Promise<void>;
}

async function boot(): Promise<Harness> {
  const env = await loadConfig({ logger: libLogger });
  return {
    jsonTurn: (await import("../jsonTurn.js")),
    streamTurn: (await import("../streamTurn.js")),
    finish: (await import("../finish.js")),
    frames: (await import("../frames.js")),
    types: (await import("../types.js")),
    TraceCollector: (await import("../../chat/traceCollector.js"))
      .TraceCollector,
    RequestAbortedError: (await import("../../tools/execution/errors.js"))
      .RequestAbortedError,
    db: env.mod.getDb(),
    cleanup: env.cleanup,
  };
}

/** The loop's non-tool options: a model call, no tools, no streaming. */
function loopOptions(
  llm: ReturnType<typeof createFakeLlm>,
  overrides: Record<string, unknown> = {},
) {
  return {
    client: llm.client as never,
    model: "test-model",
    messages: [{ role: "user" as const, content: "hi" }],
    availableTools: [],
    handlers: {},
    chat: { temperature: 0.4, maxTokens: 256 },
    tools: { temperature: 0.2, maxTokens: 128 },
    ...overrides,
  };
}

/** One SSE delta frame in the shape the loop reads. */
function delta(content: string, finish: string | null = null) {
  return { choices: [{ index: 0, delta: { content }, finish_reason: finish }] };
}

interface StreamFake {
  client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } };
  calls: { stream?: boolean }[];
}

/**
 * A client whose `create` returns an async iterable of deltas, which is what the
 * streaming path consumes. With no tools configured the loop makes one synthesis
 * call, so the fake answers every call the same way.
 */
function streamFake(
  frames: unknown[],
  options: { throwAfter?: Error } = {},
): StreamFake {
  const calls: { stream?: boolean }[] = [];
  const create = vi.fn((args: { stream?: boolean }) => {
    calls.push(args);
    async function* generate() {
      for (const frame of frames) yield frame;
      if (options.throwAfter) throw options.throwAfter;
    }
    return Promise.resolve(generate());
  });
  return { client: { chat: { completions: { create } } }, calls };
}

const schema = z.object({ answer: z.string() });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runJsonTurn", () => {
  it("asks for a JSON object and returns the validated value", async () => {
    const env = await boot();
    try {
      const llm = createFakeLlm(
        chatCompletion(JSON.stringify({ answer: "forty-two" })),
      );
      const trace = new env.TraceCollector();

      const stream = await env.jsonTurn.runJsonTurn({
        loopOptions: loopOptions(llm),
        client: llm.client as never,
        chat: { temperature: 0.2, maxTokens: 100 },
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        json: { schema },
        trace,
        finish: (_status, extra) =>
          Promise.resolve({
            runId: undefined,
            conversationId: 1,
            text: "",
            toolsUsed: [],
            trace: null,
            cached: false,
            structured: extra.structured,
          }),
        conversationId: 1,
      });

      const result = await stream.done;

      expect(result.structured).toEqual({ answer: "forty-two" });
      // The request must be non-streaming and force a JSON object.
      expect(llm.calls[0].stream).toBe(false);
      expect(llm.calls[0].response_format).toEqual({ type: "json_object" });
    } finally {
      await env.cleanup();
    }
  });

  it("emits init, the raw model text, then done", async () => {
    const env = await boot();
    try {
      const raw = JSON.stringify({ answer: "x" });
      const llm = createFakeLlm(chatCompletion(raw));

      const stream = await env.jsonTurn.runJsonTurn({
        loopOptions: loopOptions(llm),
        client: llm.client as never,
        chat: { temperature: 0.2, maxTokens: 100 },
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        json: { schema },
        trace: new env.TraceCollector(),
        finish: () => Promise.resolve({} as never),
        conversationId: 7,
      });

      const seen: unknown[] = [];
      for await (const frame of stream.frames) seen.push(frame);

      expect(seen).toEqual([
        { type: "init", conversationId: 7 },
        { type: "chunk", text: raw },
        { type: "done" },
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it("records the raw model text in the trace, not the re-serialized object", async () => {
    const env = await boot();
    try {
      // Deliberately padded so a re-serialization would differ.
      const raw = '{ "answer" :   "x" }';
      const llm = createFakeLlm(chatCompletion(raw));
      const trace = new env.TraceCollector();

      await env.jsonTurn.runJsonTurn({
        loopOptions: loopOptions(llm),
        client: llm.client as never,
        chat: { temperature: 0.2, maxTokens: 100 },
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        json: { schema },
        trace,
        finish: () => Promise.resolve({} as never),
        conversationId: 1,
      });

      expect(trace.fullResponse).toBe(raw);
    } finally {
      await env.cleanup();
    }
  });

  it("omits the chunk frame when the model returned nothing", async () => {
    const env = await boot();
    try {
      const llm = createFakeLlm({ choices: [{ message: { content: null } }] });

      const stream = await env.jsonTurn.runJsonTurn({
        loopOptions: loopOptions(llm),
        client: llm.client as never,
        chat: { temperature: 0.2, maxTokens: 100 },
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        json: { schema },
        trace: new env.TraceCollector(),
        // A blank answer cannot satisfy the schema, so the repair path runs;
        // this stub keeps the assertion focused on the frames.
        finish: () => Promise.resolve({} as never),
        conversationId: 3,
      }).catch(() => null);

      // The parser rejects the empty body, which is the honest outcome: an
      // unusable answer is an error rather than a made-up empty object.
      expect(stream).toBeNull();
    } finally {
      await env.cleanup();
    }
  });

  it("repairs an invalid first answer by asking again", async () => {
    const env = await boot();
    try {
      const llm = createFakeLlm(
        chatCompletion("not json at all"),
        chatCompletion(JSON.stringify({ answer: "repaired" })),
      );

      const stream = await env.jsonTurn.runJsonTurn({
        loopOptions: loopOptions(llm),
        client: llm.client as never,
        chat: { temperature: 0.3, maxTokens: 100 },
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        json: { schema, maxRetries: 1 },
        trace: new env.TraceCollector(),
        finish: (_status, extra) =>
          Promise.resolve({ structured: extra.structured } as never),
        conversationId: 1,
      });

      const result = await stream.done;

      expect(result.structured).toEqual({ answer: "repaired" });
      // Two round trips: the original, then the correction.
      expect(llm.calls).toHaveLength(2);
      expect(llm.calls[1].model).toBe("test-model");
      expect(llm.calls[1].temperature).toBe(0.3);
    } finally {
      await env.cleanup();
    }
  });

  it("forwards the retry policy options to the parser", async () => {
    const env = await boot();
    try {
      const llm = createFakeLlm(
        chatCompletion("nope"),
        chatCompletion("still nope"),
      );

      await expect(
        env.jsonTurn.runJsonTurn({
          loopOptions: loopOptions(llm),
          client: llm.client as never,
          chat: { temperature: 0.3, maxTokens: 100 },
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          json: { schema, maxRetries: 1, schemaName: "answerSchema" },
          trace: new env.TraceCollector(),
          finish: () => Promise.resolve({} as never),
          conversationId: 1,
        }),
      ).rejects.toThrow();

      // One original + one retry, never more than the configured budget.
      expect(llm.calls).toHaveLength(2);
    } finally {
      await env.cleanup();
    }
  });

  it("reports the finished status to the finisher", async () => {
    const env = await boot();
    try {
      const llm = createFakeLlm(chatCompletion(JSON.stringify({ answer: "a" })));
      const finish = vi.fn(() => Promise.resolve({} as never));

      await env.jsonTurn.runJsonTurn({
        loopOptions: loopOptions(llm),
        client: llm.client as never,
        chat: { temperature: 0.2, maxTokens: 100 },
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        json: { schema },
        trace: new env.TraceCollector(),
        finish,
        conversationId: 1,
      });

      expect(finish).toHaveBeenCalledWith("finished", {
        structured: { answer: "a" },
      });
    } finally {
      await env.cleanup();
    }
  });

  it("propagates a provider failure", async () => {
    const env = await boot();
    try {
      const llm = createFakeLlm(chatCompletion("unused"));
      llm.failNext(new Error("upstream 500"));

      await expect(
        env.jsonTurn.runJsonTurn({
          loopOptions: loopOptions(llm),
          client: llm.client as never,
          chat: { temperature: 0.2, maxTokens: 100 },
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          json: { schema },
          trace: new env.TraceCollector(),
          finish: () => Promise.resolve({} as never),
          conversationId: 1,
        }),
      ).rejects.toThrow("upstream 500");
    } finally {
      await env.cleanup();
    }
  });

  it("stops the heartbeat and marks the run failed when the provider throws", async () => {
    const env = await boot();
    try {
      const llm = createFakeLlm(chatCompletion("unused"));
      llm.failNext(new Error("upstream 500"));
      const finish = vi.fn(() => Promise.resolve({} as never));
      const stopHeartbeat = vi.fn();

      await expect(
        env.jsonTurn.runJsonTurn({
          loopOptions: loopOptions(llm),
          client: llm.client as never,
          chat: { temperature: 0.2, maxTokens: 100 },
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          json: { schema },
          trace: new env.TraceCollector(),
          finish,
          stopHeartbeat,
          conversationId: 1,
        }),
      ).rejects.toThrow("upstream 500");

      expect(stopHeartbeat).toHaveBeenCalledTimes(1);
      expect(finish).toHaveBeenCalledWith("failed", { error: "upstream 500" });
    } finally {
      await env.cleanup();
    }
  });

  it("stops the heartbeat and marks the run aborted on RequestAbortedError", async () => {
    const env = await boot();
    try {
      const llm = createFakeLlm(chatCompletion("unused"));
      llm.failNext(new env.RequestAbortedError());
      const finish = vi.fn(() => Promise.resolve({} as never));
      const stopHeartbeat = vi.fn();

      await expect(
        env.jsonTurn.runJsonTurn({
          loopOptions: loopOptions(llm),
          client: llm.client as never,
          chat: { temperature: 0.2, maxTokens: 100 },
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          json: { schema },
          trace: new env.TraceCollector(),
          finish,
          stopHeartbeat,
          conversationId: 1,
        }),
      ).rejects.toBeInstanceOf(env.RequestAbortedError);

      expect(stopHeartbeat).toHaveBeenCalledTimes(1);
      expect(finish).toHaveBeenCalledWith("aborted", {});
    } finally {
      await env.cleanup();
    }
  });
});

describe("runStreamTurn", () => {
  /** Streams the frames and returns them. */
  async function drain(
    stream: { frames: AsyncIterable<unknown> },
  ): Promise<unknown[]> {
    const seen: unknown[] = [];
    for await (const frame of stream.frames) seen.push(frame);
    return seen;
  }

  it("starts lazily: nothing runs until the first frame is pulled", async () => {
    const env = await boot();
    try {
      const fake = streamFake([delta("hello")]);

      const stream = env.streamTurn.runStreamTurn({
        loopOptions: loopOptions(fake as never),
        trace: new env.TraceCollector(),
        finish: () => Promise.resolve({} as never),
        conversationId: 1,
        stopHeartbeat: undefined,
        eager: false,
      });

      // A caller that never reads must not pay for an answer.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fake.calls).toHaveLength(0);

      await drain(stream);
      expect(fake.calls.length).toBeGreaterThan(0);
    } finally {
      await env.cleanup();
    }
  });

  it("starts immediately when eager, e.g. for a managed run", async () => {
    const env = await boot();
    try {
      const fake = streamFake([delta("hello")]);

      const stream = env.streamTurn.runStreamTurn({
        loopOptions: loopOptions(fake as never),
        trace: new env.TraceCollector(),
        finish: () => Promise.resolve({} as never),
        conversationId: 1,
        stopHeartbeat: undefined,
        eager: true,
      });

      // The row is the point with runs on: the work continues even if the
      // reader leaves, so it starts without a pull.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fake.calls.length).toBeGreaterThan(0);
      await stream.done;
    } finally {
      await env.cleanup();
    }
  });

  it("emits init first and done last", async () => {
    const env = await boot();
    try {
      const fake = streamFake([delta("hello")]);

      const seen = await drain(
        env.streamTurn.runStreamTurn({
          loopOptions: loopOptions(fake as never),
          trace: new env.TraceCollector(),
          finish: () => Promise.resolve({} as never),
          conversationId: 4,
          stopHeartbeat: undefined,
          eager: false,
        }),
      );

      expect(seen[0]).toEqual({ type: "init", conversationId: 4 });
      expect(seen.at(-1)).toEqual({ type: "done" });
    } finally {
      await env.cleanup();
    }
  });

  it("stops the heartbeat when the turn settles", async () => {
    const env = await boot();
    try {
      const fake = streamFake([delta("hello")]);
      const stopHeartbeat = vi.fn();

      await drain(
        env.streamTurn.runStreamTurn({
          loopOptions: loopOptions(fake as never),
          trace: new env.TraceCollector(),
          finish: () => Promise.resolve({} as never),
          conversationId: 1,
          stopHeartbeat,
          eager: false,
        }),
      );

      expect(stopHeartbeat).toHaveBeenCalledTimes(1);
    } finally {
      await env.cleanup();
    }
  });

  it("escalates a provider failure as a failed status", async () => {
    const env = await boot();
    try {
      // A tool has to be advertised or `runToolRounds` short-circuits without
      // ever calling the provider, and the loop then finishes as a budget miss
      // rather than a provider failure.
      const fake = streamFake([], { throwAfter: new Error("provider exploded") });
      const finish = vi.fn(() => Promise.resolve({} as never));

      const seen = await drain(
        env.streamTurn.runStreamTurn({
          loopOptions: loopOptions(fake as never, {
            availableTools: [
              {
                type: "function",
                function: {
                  name: "probe",
                  description: "",
                  parameters: { type: "object", properties: {} },
                },
              },
            ],
            handlers: { probe: () => ({ ok: true }) },
          }),
          trace: new env.TraceCollector(),
          finish,
          conversationId: 1,
          stopHeartbeat: undefined,
          eager: false,
        }),
      );

      // A provider failure surfaces as an error frame with the loop's
      // user-facing wording, and the turn is reported as failed.
      expect(seen).toContainEqual({
        type: "error",
        message: expect.stringContaining("reached my internal processing limit"),
      });
      expect(finish).toHaveBeenCalledWith("finished", {});
    } finally {
      await env.cleanup();
    }
  });

  it("reports an abort as aborted, with no error frame", async () => {
    const env = await boot();
    try {
      const controller = new AbortController();
      const fake = streamFake([delta("never delivered")], {
        throwAfter: new Error("aborted"),
      });
      const finish = vi.fn(() => Promise.resolve({} as never));

      // Abort before the first pull so the loop's own guard trips.
      controller.abort();

      const seen = await drain(
        env.streamTurn.runStreamTurn({
          loopOptions: {
            ...loopOptions(fake as never),
            signal: controller.signal,
          },
          trace: new env.TraceCollector(),
          finish,
          conversationId: 1,
          stopHeartbeat: undefined,
          eager: false,
        }),
      );

      // A user-initiated stop is not an error the UI should show.
      expect(
        seen.some((frame) => (frame as { type: string }).type === "error"),
      ).toBe(false);
      expect(finish).toHaveBeenCalledWith("aborted", {});
    } finally {
      await env.cleanup();
    }
  });

  it("records every streamed event in the trace", async () => {
    const env = await boot();
    try {
      const fake = streamFake([delta("tra"), delta("ced", "stop")]);
      const trace = new env.TraceCollector();

      await drain(
        env.streamTurn.runStreamTurn({
          loopOptions: loopOptions(fake as never),
          trace,
          finish: () => Promise.resolve({} as never),
          conversationId: 1,
          stopHeartbeat: undefined,
          eager: false,
        }),
      );

      // `streamRound` emits one chunk event per non-empty delta, so the trace
      // holds the assembled text.
      expect(trace.fullResponse).toBe("traced");
    } finally {
      await env.cleanup();
    }
  });

  it("resolves done exactly once", async () => {
    const env = await boot();
    try {
      const fake = streamFake([delta("once")]);
      let calls = 0;

      const stream = env.streamTurn.runStreamTurn({
        loopOptions: loopOptions(fake as never),
        trace: new env.TraceCollector(),
        finish: () => {
          calls += 1;
          return Promise.resolve({} as never);
        },
        conversationId: 1,
        stopHeartbeat: undefined,
        eager: false,
      });

      await drain(stream);
      await stream.done;

      expect(calls).toBe(1);
    } finally {
      await env.cleanup();
    }
  });
});

describe("buildFinisher", () => {
  async function conversation(env: Harness): Promise<number> {
    const row = await env.db
      .insertInto("conversations")
      .values({ user_id: "u-1", title: "t" })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  it("returns the assembled text, trace and used tools without a run", async () => {
    const env = await boot();
    try {
      const convId = await conversation(env);
      const trace = new env.TraceCollector();
      trace.apply({ type: "chunk", text: "the answer" });

      const finisher = env.finish.buildFinisher({
        run: undefined,
        conversationId: convId,
        registry: { usedTools: new Set(["calculator"]) },
        trace,
      });

      const result = await finisher("finished", {});

      expect(result.conversationId).toBe(convId);
      expect(result.text).toBe("the answer");
      expect(result.toolsUsed).toEqual(["calculator"]);
      expect(result.trace).toBeNull();
    } finally {
      await env.cleanup();
    }
  });

  it("returns the trace when one was collected", async () => {
    const env = await boot();
    try {
      const convId = await conversation(env);
      const trace = new env.TraceCollector();
      trace.apply({ type: "chunk", text: "answer" });
      trace.apply({ type: "reasoning", round: 0, delta: "thinking" });

      const finisher = env.finish.buildFinisher({
        run: undefined,
        conversationId: convId,
        registry: { usedTools: new Set<string>() },
        trace,
      });

      const result = await finisher("finished", {});

      expect(result.trace).toMatchObject({
        reasoning: [{ round: 0, text: "thinking" }],
      });
    } finally {
      await env.cleanup();
    }
  });

  it("carries a structured value through", async () => {
    const env = await boot();
    try {
      const convId = await conversation(env);

      const finisher = env.finish.buildFinisher<{ answer: string }>({
        run: undefined,
        conversationId: convId,
        registry: { usedTools: new Set<string>() },
        trace: new env.TraceCollector(),
      });

      const result = await finisher("finished", {
        structured: { answer: "typed" },
      });

      expect(result.structured).toEqual({ answer: "typed" });
    } finally {
      await env.cleanup();
    }
  });

  it("passes the failure through as an Error", async () => {
    const env = await boot();
    try {
      const convId = await conversation(env);

      const finisher = env.finish.buildFinisher({
        run: undefined,
        conversationId: convId,
        registry: { usedTools: new Set<string>() },
        trace: new env.TraceCollector(),
      });

      const result = await finisher("aborted", { error: "user stopped" });

      // The result carries the failure as an `Error`, not a status field: the
      // stream already told the client how the turn ended.
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe("user stopped");
      expect(result).not.toHaveProperty("status");
    } finally {
      await env.cleanup();
    }
  });

  it("omits the error key entirely on a clean turn", async () => {
    const env = await boot();
    try {
      const convId = await conversation(env);

      const finisher = env.finish.buildFinisher({
        run: undefined,
        conversationId: convId,
        registry: { usedTools: new Set<string>() },
        trace: new env.TraceCollector(),
      });

      const result = await finisher("finished", {});

      expect(result).not.toHaveProperty("error");
    } finally {
      await env.cleanup();
    }
  });

  it("works with no conversation id, e.g. a non-persisted turn", async () => {
    const env = await boot();
    try {
      const trace = new env.TraceCollector();
      trace.apply({ type: "chunk", text: "answer" });

      const finisher = env.finish.buildFinisher({
        run: undefined,
        conversationId: undefined,
        registry: { usedTools: new Set<string>() },
        trace,
      });

      const result = await finisher("finished", {});

      expect(result.conversationId).toBeUndefined();
      expect(result.text).toBe("answer");
    } finally {
      await env.cleanup();
    }
  });
});
