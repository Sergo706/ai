import { describe, expect, it, vi } from "vitest";
import type { ToolLoopOptions } from "~~/src/types/ToolExecutionTypes.js";
import { completeFinalAnswer } from "../completeFinalAnswer.js";
import { executeToolLoop } from "../executeToolLoop.js";

const h = vi.hoisted(() => ({ runToolRounds: vi.fn() }));

vi.mock("../runRounds.ts", () => ({ runToolRounds: h.runToolRounds }));

function options(overrides: Partial<ToolLoopOptions> = {}): ToolLoopOptions {
  return {
    client: { chat: { completions: { create: vi.fn() } } } as never,
    model: "deepseek-chat",
    messages: [],
    availableTools: [],
    tools: { temperature: 0.2 } as never,
    chat: { temperature: 0.4, maxTokens: 1_000 },
    ...overrides,
  };
}

function completion(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content: "final answer", refusal: null },
      },
    ],
    ...overrides,
  };
}

describe("completeFinalAnswer", () => {
  it("returns the loop's own completion when it finished naturally", async () => {
    const natural = completion();
    h.runToolRounds.mockResolvedValue({ completedCompletion: natural });
    await expect(completeFinalAnswer(options())).resolves.toBe(natural);
  });

  it("makes the synthesis call when the budget ran out", async () => {
    const create = vi.fn().mockResolvedValue(completion());
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });

    const result = await completeFinalAnswer(
      options({ client: { chat: { completions: { create } } } as never }),
    );

    expect(result.choices[0]?.message.content).toBe("final answer");
    expect(create).toHaveBeenCalledWith(
      { model: "deepseek-chat", messages: [] },
      expect.objectContaining({ signal: undefined }),
    );
  });

  it("forwards the abort signal to the synthesis call", async () => {
    const controller = new AbortController();
    const create = vi.fn().mockResolvedValue(completion());
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });

    await completeFinalAnswer(
      options({
        client: { chat: { completions: { create } } } as never,
        signal: controller.signal,
      }),
    );

    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it("throws when the loop produced neither a completion nor a request", async () => {
    h.runToolRounds.mockResolvedValue({});
    await expect(completeFinalAnswer(options())).rejects.toThrow(
      /Unable to complete the response/,
    );
  });

  it("rejects a synthesis response that still asks for tools", async () => {
    const create = vi.fn().mockResolvedValue(
      completion({
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            logprobs: null,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "a",
                  type: "function",
                  function: { name: "search", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    );
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });

    await expect(
      completeFinalAnswer(
        options({ client: { chat: { completions: { create } } } as never }),
      ),
    ).rejects.toThrow(/without tool calls/);
  });

  it("rejects a synthesis response with a legacy function_call", async () => {
    const create = vi.fn().mockResolvedValue(
      completion({
        choices: [
          {
            index: 0,
            finish_reason: "function_call",
            logprobs: null,
            message: {
              role: "assistant",
              content: null,
              function_call: { name: "search", arguments: "{}" },
            },
          },
        ],
      }),
    );
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });

    await expect(
      completeFinalAnswer(
        options({ client: { chat: { completions: { create } } } as never }),
      ),
    ).rejects.toThrow(/without tool calls/);
  });

  it("rejects a synthesis response with no choices", async () => {
    const create = vi.fn().mockResolvedValue(completion({ choices: [] }));
    h.runToolRounds.mockResolvedValue({
      finalRequest: { model: "deepseek-chat", messages: [] },
    });

    await expect(
      completeFinalAnswer(
        options({ client: { chat: { completions: { create } } } as never }),
      ),
    ).rejects.toThrow(/without tool calls/);
  });
});

describe("executeToolLoop", () => {
  it("returns a generator in stream mode", () => {
    h.runToolRounds.mockResolvedValue({ answerStreamed: true });
    const result = executeToolLoop({ ...options(), stream: true });
    expect(typeof (result as AsyncGenerator).next).toBe("function");
  });

  it("returns a promise in non-stream mode", () => {
    h.runToolRounds.mockResolvedValue({ completedCompletion: completion() });
    const result = executeToolLoop(options());
    expect(result).toBeInstanceOf(Promise);
  });
});
