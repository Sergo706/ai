import { describe, expect, it, vi } from "vitest";
import type { ToolLoopOptions } from "~~/src/types/ToolExecutionTypes.js";
import { RequestAbortedError } from "../errors.js";
import { streamRound } from "../streamRound.js";

interface Frame {
  index?: number;
  delta?: {
    content?: string | null;
    tool_calls?: unknown[];
    reasoning_content?: string | null;
    function_call?: unknown;
  };
  finish_reason?: string | null;
}

function chunk(frames: Frame[]) {
  return {
    choices: frames.map((frame) => ({
      index: frame.index ?? 0,
      delta: frame.delta ?? {},
      finish_reason: frame.finish_reason ?? null,
    })),
  };
}

/** Every entry is one SSE chunk, which is how the providers actually frame it. */
function streamingClient(frames: Frame[]) {
  const create = vi.fn(async (..._args: unknown[]) => {
    async function* generate() {
      for (const frame of frames) yield chunk([frame]);
    }
    return generate();
  });
  return { client: { chat: { completions: { create } } } as never, create };
}

function options(overrides: Partial<ToolLoopOptions> = {}): ToolLoopOptions {
  return {
    client: streamingClient([]).client,
    model: "deepseek-chat",
    messages: [{ role: "user", content: "hi" }],
    availableTools: [
      { type: "function", function: { name: "search", parameters: {} } },
    ] as never,
    tools: { temperature: 0.2, maxRounds: 5, maxCalls: 20 } as never,
    chat: { temperature: 0.4, maxTokens: 1_000 },
    ...overrides,
  };
}

describe("streamRound", () => {
  it("returns an answer when the model produced text and no tool calls", async () => {
    const { client } = streamingClient([
      { delta: { content: "Hello " } },
      { delta: { content: "world" } },
    ]);
    const outcome = await streamRound(
      options({ client }),
      [{ role: "user", content: "hi" }],
      [],
      0,
    );
    expect(outcome).toEqual({ kind: "answer", content: "Hello world" });
  });

  it("emits every content delta as a chunk event", async () => {
    const emit = vi.fn();
    const { client } = streamingClient([
      { delta: { content: "a" } },
      { delta: { content: "b" } },
    ]);
    await streamRound(
      options({ client, emit }),
      [{ role: "user", content: "hi" }],
      [],
      0,
    );
    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      { type: "chunk", text: "a" },
      { type: "chunk", text: "b" },
    ]);
  });

  it("forwards reasoning deltas tagged with the round number", async () => {
    const emit = vi.fn();
    const { client } = streamingClient([
      { delta: { reasoning_content: "step 1" } },
      { delta: { content: "answer" } },
    ]);
    await streamRound(
      options({ client, emit }),
      [{ role: "user", content: "hi" }],
      [],
      2,
    );
    expect(emit).toHaveBeenCalledWith({
      type: "reasoning",
      round: 2,
      delta: "step 1",
    });
  });

  it("assembles a tool call split across frames", async () => {
    const { client } = streamingClient([
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_a",
              function: { name: "search", arguments: '{"q"' },
            },
          ],
        },
      },
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: ':"pizza"}' } }],
        },
      },
      { finish_reason: "tool_calls" },
    ]);

    const outcome = await streamRound(
      options({ client }),
      [{ role: "user", content: "hi" }],
      [],
      0,
    );

    expect(outcome).toEqual({
      kind: "tools",
      content: "",
      calls: [{ id: "call_a", name: "search", arguments: '{"q":"pizza"}' }],
    });
  });

  it("keeps parallel tool calls in provider index order", async () => {
    const { client } = streamingClient([
      {
        delta: {
          tool_calls: [
            {
              index: 1,
              id: "second",
              function: { name: "b", arguments: "{}" },
            },
            { index: 0, id: "first", function: { name: "a", arguments: "{}" } },
          ],
        },
      },
    ]);

    const outcome = await streamRound(
      options({ client }),
      [{ role: "user", content: "hi" }],
      [],
      0,
    );

    expect(outcome.kind).toBe("tools");
    if (outcome.kind === "tools") {
      expect(outcome.calls.map((call) => call.id)).toEqual(["first", "second"]);
    }
  });

  it("keeps the assistant preamble that preceded the tool call", async () => {
    const { client } = streamingClient([
      {
        delta: {
          content: "Let me check that.",
          tool_calls: [
            {
              index: 0,
              id: "a",
              function: { name: "search", arguments: "{}" },
            },
          ],
        },
      },
    ]);
    const outcome = await streamRound(
      options({ client }),
      [{ role: "user", content: "hi" }],
      [],
      0,
    );
    expect(outcome.kind === "tools" && outcome.content).toBe(
      "Let me check that.",
    );
  });

  it("throws when the provider truncated the round", async () => {
    const { client } = streamingClient([
      { delta: { content: "half a sen" } },
      { finish_reason: "length" },
    ]);
    await expect(
      streamRound(
        options({ client }),
        [{ role: "user", content: "hi" }],
        [],
        0,
      ),
    ).rejects.toThrow(/Unable to complete the response/);
  });

  it("sends the model, temperature, token cap and tools", async () => {
    const { client, create } = streamingClient([]);
    await streamRound(
      options({ client }),
      [{ role: "user", content: "hi" }],
      [
        { type: "function", function: { name: "search", parameters: {} } },
      ] as never,
      0,
    );
    const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.model).toBe("deepseek-chat");
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(1_000);
    expect(body.tool_choice).toBe("auto");
    expect(body.stream).toBe(true);
  });

  it("adds the thinking flags when an effort is set", async () => {
    const { client, create } = streamingClient([]);
    await streamRound(
      options({ client, thinkingEffort: "high" }),
      [{ role: "user", content: "hi" }],
      [],
      0,
    );
    const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("high");
  });

  it("passes the abort signal to the provider", async () => {
    const controller = new AbortController();
    const { client, create } = streamingClient([]);
    await streamRound(
      options({ client, signal: controller.signal }),
      [{ role: "user", content: "hi" }],
      [],
      0,
    );
    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it("ignores chunks that belong to another choice index", async () => {
    const emit = vi.fn();
    const { client } = streamingClient([
      { index: 1, delta: { content: "other" } },
      { delta: { content: "mine" } },
    ]);
    const outcome = await streamRound(
      options({ client, emit }),
      [{ role: "user", content: "hi" }],
      [],
      0,
    );
    expect(outcome).toEqual({ kind: "answer", content: "mine" });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("returns an empty answer when the provider sent nothing at all", async () => {
    const { client } = streamingClient([]);
    const outcome = await streamRound(
      options({ client }),
      [{ role: "user", content: "hi" }],
      [],
      0,
    );
    expect(outcome).toEqual({ kind: "answer", content: "" });
  });

  it("propagates an abort that fires while the stream is open", async () => {
    const controller = new AbortController();
    const create = vi.fn(async () => {
      async function* generate() {
        yield chunk([{ delta: { content: "a" } }]);
        controller.abort();
        throw new RequestAbortedError();
      }
      return generate();
    });
    await expect(
      streamRound(
        options({
          client: { chat: { completions: { create } } } as never,
          signal: controller.signal,
        }),
        [{ role: "user", content: "hi" }],
        [],
        0,
      ),
    ).rejects.toThrow(RequestAbortedError);
  });
});
