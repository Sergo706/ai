import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  ToolLoopOptions,
} from "~~/src/types/ToolExecutionTypes.js";
import { RequestAbortedError } from "../errors.js";
import { streamFinalAnswer } from "../streamFinalAnswer.js";

const h = vi.hoisted(() => ({ runToolRounds: vi.fn() }));

vi.mock("../runRounds.ts", () => ({ runToolRounds: h.runToolRounds }));

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { choices: [{ index: 0, delta, finish_reason: finish }] };
}

function synthesisClient(frames: unknown[]) {
  const create = vi.fn(async (..._args: unknown[]) => {
    async function* generate() {
      for (const frame of frames) yield frame;
    }
    return generate();
  });
  return { client: { chat: { completions: { create } } } as never, create };
}

function options(overrides: Partial<ToolLoopOptions> = {}): ToolLoopOptions {
  return {
    client: synthesisClient([]).client,
    model: "deepseek-chat",
    messages: [],
    availableTools: [],
    tools: { temperature: 0.2 } as never,
    chat: { temperature: 0.4, maxTokens: 1_000 },
    stream: true,
    ...overrides,
  };
}

async function drain(
  generator: AsyncGenerator<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe("streamFinalAnswer", () => {
  it("yields nothing when the loop already streamed the answer", async () => {
    h.runToolRounds.mockResolvedValue({ answerStreamed: true });
    await expect(drain(streamFinalAnswer(options()))).resolves.toEqual([]);
  });

  it("streams the synthesized answer when the budget ran out", async () => {
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });
    const { client } = synthesisClient([
      chunk({ content: "Here " }),
      chunk({ content: "it is." }, "stop"),
    ]);

    const events = await drain(streamFinalAnswer(options({ client })));

    expect(events).toEqual([
      { type: "chunk", text: "Here " },
      { type: "chunk", text: "it is." },
    ]);
  });

  it("re-tags synthesized reasoning as round -1", async () => {
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });
    const { client } = synthesisClient([
      chunk({ reasoning_content: "thinking" }),
      chunk({ content: "answer" }, "stop"),
    ]);

    const events = await drain(streamFinalAnswer(options({ client })));

    expect(events[0]).toEqual({
      type: "reasoning",
      round: -1,
      delta: "thinking",
    });
  });

  it("forces streaming and the thinking flags on the synthesis call", async () => {
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [], stream: false },
    });
    const { client, create } = synthesisClient([]);

    await drain(streamFinalAnswer(options({ client, thinkingEffort: "high" })));

    const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("surfaces a tool-call frame in the final answer as an error event", async () => {
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });
    const { client } = synthesisClient([
      chunk({
        tool_calls: [{ index: 0, id: "a", function: { name: "search" } }],
      }),
    ]);

    const events = await drain(streamFinalAnswer(options({ client })));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  it("treats a finish_reason of tool_calls in the synthesis turn as an error", async () => {
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });
    const { client } = synthesisClient([chunk({ content: "x" }, "tool_calls")]);

    const events = await drain(streamFinalAnswer(options({ client })));

    expect(events[0]?.type).toBe("error");
  });

  it("errors when the stream ended without a finish_reason", async () => {
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });
    const { client } = synthesisClient([chunk({ content: "cut off" })]);

    const events = await drain(streamFinalAnswer(options({ client })));

    expect(events.map((event) => event.type)).toEqual(["chunk", "error"]);
  });

  it("errors if any chunk arrives after the finish_reason", async () => {
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });
    const { client } = synthesisClient([
      chunk({ content: "done" }, "stop"),
      chunk({ content: "extra" }),
    ]);

    const events = await drain(streamFinalAnswer(options({ client })));

    expect(events.at(-1)?.type).toBe("error");
  });

  it("errors when the loop produced no request at all", async () => {
    h.runToolRounds.mockResolvedValue({});
    const events = await drain(streamFinalAnswer(options()));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  it("ignores chunks for a non-zero choice index", async () => {
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });
    const { client } = synthesisClient([
      {
        choices: [
          { index: 1, delta: { content: "other" }, finish_reason: null },
        ],
      },
      chunk({ content: "mine" }, "stop"),
    ]);

    const events = await drain(streamFinalAnswer(options({ client })));

    expect(events).toEqual([{ type: "chunk", text: "mine" }]);
  });

  it("rethrows RequestAbortedError instead of emitting an error event", async () => {
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });
    const create = vi.fn(async () => {
      throw new RequestAbortedError();
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      drain(
        streamFinalAnswer(
          options({
            client: { chat: { completions: { create } } } as never,
            signal: controller.signal,
          }),
        ),
      ),
    ).rejects.toThrow(RequestAbortedError);
  });

  it("rethrows RequestAbortedError even when the signal object is the only evidence", async () => {
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });
    const create = vi.fn(async () => {
      throw new RequestAbortedError();
    });

    await expect(
      drain(
        streamFinalAnswer(
          options({ client: { chat: { completions: { create } } } as never }),
        ),
      ),
    ).rejects.toThrow(RequestAbortedError);
  });

  it("carries a user-facing message that does not leak internals", async () => {
    h.runToolRounds.mockRejectedValue(new Error("ECONNRESET deepseek-prod-7"));
    const events = await drain(streamFinalAnswer(options()));
    const message = (events[0] as { message: string }).message;
    expect(message).not.toMatch(/ECONNRESET|deepseek-prod/);
    expect(message).toMatch(/internal processing limit/);
  });
});
