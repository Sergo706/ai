import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  ToolLoopOptions,
} from "~~/src/types/ToolExecutionTypes.js";
import { RequestAbortedError } from "../errors.js";
import { runToolRounds } from "../runRounds.js";

/* ------------------------------------------------------------------ */
/* A controllable fake provider: each round is a scripted frame list.  */
/* ------------------------------------------------------------------ */

interface Frame {
  content?: string;
  reasoning?: string;
  toolCalls?: { index: number; id?: string; name?: string; args?: string }[];
  finish?: string | null;
}

function toChunk(frame: Frame) {
  const tool_calls = (frame.toolCalls ?? []).map((call) => ({
    index: call.index,
    ...(call.id === undefined ? {} : { id: call.id }),
    function: {
      ...(call.name === undefined ? {} : { name: call.name }),
      ...(call.args === undefined ? {} : { arguments: call.args }),
    },
  }));

  return {
    choices: [
      {
        index: 0,
        delta: {
          ...(frame.content === undefined ? {} : { content: frame.content }),
          ...(frame.reasoning === undefined
            ? {}
            : { reasoning_content: frame.reasoning }),
          ...(tool_calls.length > 0 ? { tool_calls } : {}),
        },
        finish_reason: frame.finish ?? null,
      },
    ],
  };
}

function scriptedClient(rounds: Frame[][]) {
  let call = 0;
  const create = vi.fn(async (..._args: unknown[]) => {
    const frames = rounds[call] ?? [];
    call += 1;
    async function* generate() {
      for (const frame of frames) yield toChunk(frame);
    }
    return generate();
  });
  return { client: { chat: { completions: { create } } } as never, create };
}

const searchTool = {
  type: "function" as const,
  function: { name: "search", parameters: { type: "object" } },
};

function base(overrides: Partial<ToolLoopOptions> = {}): ToolLoopOptions {
  return {
    client: scriptedClient([]).client,
    model: "deepseek-chat",
    messages: [{ role: "user", content: "find pizza places" }],
    availableTools: [searchTool] as never,
    tools: { temperature: 0.2, maxRounds: 3, maxCalls: 10 } as never,
    chat: { temperature: 0.4, maxTokens: 1_000 },
    ...overrides,
  };
}

/** A single round that asks for one tool call. */
function toolRound(id: string, name = "search", args = '{"q":"pizza"}') {
  return [
    { toolCalls: [{ index: 0, id, name, args }] },
    { finish: "tool_calls" },
  ];
}

function answerRound(text: string) {
  return [{ content: text }, { finish: "stop" }];
}

/* ------------------------------------------------------------------ */

describe("runToolRounds — natural finish", () => {
  it("returns a synthesized completion when the model answers immediately (non-stream)", async () => {
    const { client } = scriptedClient([answerRound("Here you go.")]);
    const result = await runToolRounds(base({ client }));

    expect(result.answerStreamed).toBeUndefined();
    expect(result.finalRequest).toBeUndefined();
    const message = result.completedCompletion?.choices[0]?.message;
    expect(message?.content).toBe("Here you go.");
    expect(message?.role).toBe("assistant");
  });

  it("marks the answer as already streamed in stream mode", async () => {
    const { client } = scriptedClient([answerRound("streamed")]);
    const result = await runToolRounds(base({ client, stream: true }));
    expect(result).toEqual({ answerStreamed: true });
  });

  it("makes exactly one provider call when no tool is needed", async () => {
    const { client, create } = scriptedClient([answerRound("done")]);
    await runToolRounds(base({ client }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses to return content carrying unparsed DSML markup", async () => {
    const { client } = scriptedClient([
      answerRound("let me call <｜｜DSML｜｜tool_calls>"),
    ]);
    await expect(runToolRounds(base({ client }))).rejects.toThrow(/DSML/);
  });

  it("keeps looping when the round was silent, then synthesizes a final answer", async () => {
    const { client, create } = scriptedClient([[{ finish: "stop" }]]);
    const result = await runToolRounds(base({ client }));
    // A blank round is not a finished answer, so the loop exits and hands the
    // caller a final request instead of an empty completion.
    expect(result.finalRequest?.stream).toBe(false);
    expect(result.finalRequest?.messages.at(-1)).toEqual({
      role: "system",
      content: expect.stringContaining("final user-facing answer"),
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("runToolRounds — tool execution", () => {
  it("executes the handler and feeds the result back to the model", async () => {
    const { client, create } = scriptedClient([
      toolRound("call_a"),
      answerRound("The pizza place is open."),
    ]);
    const handler = vi.fn(() => ({ name: "Luigi's" }));

    const result = await runToolRounds(
      base({ client, handlers: { search: handler } }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.completedCompletion?.choices[0]?.message.content).toBe(
      "The pizza place is open.",
    );
    // Second request must carry the assistant tool_calls frame and the tool result.
    expect(create).toHaveBeenCalledTimes(2);
    const secondMessages = (
      create.mock.calls[1]?.[0] as { messages: unknown[] }
    ).messages;
    const assistant = secondMessages.find(
      (message) => (message as { role: string }).role === "assistant",
    ) as { tool_calls: { id: string }[] };
    expect(assistant.tool_calls[0]?.id).toBe("call_a");
    const tool = secondMessages.find(
      (message) => (message as { role: string }).role === "tool",
    ) as { tool_call_id: string; content: string };
    expect(tool.tool_call_id).toBe("call_a");
    expect(JSON.parse(tool.content)).toEqual({ name: "Luigi's" });
  });

  it("emits tool_start then tool_end with a duration", async () => {
    const emit = vi.fn<(event: AgentEvent) => void>();
    const { client } = scriptedClient([toolRound("call_a"), answerRound("ok")]);

    await runToolRounds(
      base({ client, emit, handlers: { search: () => "result" } }),
    );

    const toolEvents = emit.mock.calls
      .map((call) => call[0].type)
      .filter((type) => type.startsWith("tool_"));
    expect(toolEvents).toEqual(["tool_start", "tool_end"]);
    const end = emit.mock.calls.find(
      (call) => call[0].type === "tool_end",
    )?.[0] as { ok: boolean; durationMs: number };
    expect(end.ok).toBe(true);
    expect(typeof end.durationMs).toBe("number");
  });

  it("reports a failing tool as ok:false without aborting the round", async () => {
    const emit = vi.fn<(event: AgentEvent) => void>();
    const { client } = scriptedClient([
      toolRound("call_a"),
      answerRound("I could not reach the search API."),
    ]);

    await runToolRounds(
      base({
        client,
        emit,
        handlers: {
          search: () => {
            throw new Error("upstream 500");
          },
        },
      }),
    );

    const end = emit.mock.calls.find(
      (call) => call[0].type === "tool_end",
    )?.[0] as { ok: boolean };
    expect(end.ok).toBe(false);
  });

  it("hides the args when the tool policy suppresses them", async () => {
    const emit = vi.fn<(event: AgentEvent) => void>();
    const { client } = scriptedClient([toolRound("call_a"), answerRound("ok")]);

    await runToolRounds(
      base({
        client,
        emit,
        handlers: { search: () => "result" },
        toolStreaming: { search: { emitArgs: false } },
      }),
    );

    const start = emit.mock.calls[0]?.[0] as { args?: unknown };
    expect(start.args).toBeUndefined();
  });

  it("sends no payload at all when the policy says none", async () => {
    const emit = vi.fn<(event: AgentEvent) => void>();
    const { client } = scriptedClient([toolRound("call_a"), answerRound("ok")]);

    await runToolRounds(
      base({
        client,
        emit,
        handlers: { search: () => "long result ".repeat(100) },
        toolStreaming: { search: { emitResult: "none" } },
      }),
    );

    const end = emit.mock.calls.find(
      (call) => call[0].type === "tool_end",
    )?.[0] as { preview: string };
    expect(end.preview).toBe("");
  });

  it("truncates the preview by default", async () => {
    const emit = vi.fn<(event: AgentEvent) => void>();
    const { client } = scriptedClient([toolRound("call_a"), answerRound("ok")]);

    await runToolRounds(
      base({
        client,
        emit,
        handlers: { search: () => "x".repeat(5_000) },
      }),
    );

    const end = emit.mock.calls.find(
      (call) => call[0].type === "tool_end",
    )?.[0] as { preview: string };
    expect(end.preview.length).toBe(300);
  });

  it("hands the full unredacted result to onToolResult even when the preview is hidden", async () => {
    const onToolResult = vi.fn();
    const { client } = scriptedClient([toolRound("call_a"), answerRound("ok")]);

    await runToolRounds(
      base({
        client,
        onToolResult,
        handlers: { search: () => ({ secret: "value" }) },
        toolStreaming: { search: { emitResult: "none" } },
      }),
    );

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "call_a",
        name: "search",
        args: { q: "pizza" },
        ok: true,
        previewHidden: true,
        result: '{"secret":"value"}',
      }),
    );
  });
});

describe("runToolRounds — budgets", () => {
  it("stops after maxRounds and asks for a synthesis turn", async () => {
    const rounds = Array.from({ length: 10 }, (_unused, index) =>
      toolRound(`call_${String(index)}`),
    );
    const { client, create } = scriptedClient(rounds);

    const result = await runToolRounds(
      base({
        client,
        tools: { temperature: 0.2, maxRounds: 2, maxCalls: 10 } as never,
        handlers: { search: () => "r" },
      }),
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.finalRequest?.tool_choice).toBe("none");
    // The tools are still advertised, only the choice is forced.
    expect(result.finalRequest?.tools).toHaveLength(1);
  });

  it("refuses calls past maxCalls with an explicit error payload", async () => {
    const { client } = scriptedClient([
      [
        {
          toolCalls: [
            { index: 0, id: "a", name: "search", args: "{}" },
            { index: 1, id: "b", name: "search", args: "{}" },
            { index: 2, id: "c", name: "search", args: "{}" },
          ],
        },
      ],
    ]);
    const handler = vi.fn(() => "ok");

    const result = await runToolRounds(
      base({
        client,
        tools: { temperature: 0.2, maxRounds: 3, maxCalls: 2 } as never,
        handlers: { search: handler },
      }),
    );

    expect(handler).toHaveBeenCalledTimes(2);
    const toolMessages = (result.finalRequest?.messages ?? []).filter(
      (message) => message.role === "tool",
    ) as { content: string }[];
    expect(toolMessages).toHaveLength(3);
    expect(JSON.parse(toolMessages[2]?.content ?? "{}").error.code).toBe(
      "CALL_LIMIT_EXCEEDED",
    );
  });

  it("still answers the rejected call so the transcript stays balanced", async () => {
    const { client, create } = scriptedClient([
      [
        {
          toolCalls: [
            { index: 0, id: "a", name: "search", args: "{}" },
            { index: 1, id: "b", name: "search", args: "{}" },
          ],
        },
      ],
    ]);

    await runToolRounds(
      base({
        client,
        tools: { temperature: 0.2, maxRounds: 1, maxCalls: 1 } as never,
        handlers: { search: () => "ok" },
      }),
    );

    const sent = (create.mock.calls[0]?.[0] as { messages: unknown[] })
      .messages;
    expect(sent).toHaveLength(1);
  });

  it("synthesizes immediately when no tools were advertised", async () => {
    const { client, create } = scriptedClient([]);
    const result = await runToolRounds(base({ client, availableTools: [] }));
    expect(create).not.toHaveBeenCalled();
    // With no tools, the tools array must be omitted entirely.
    expect(result.finalRequest?.stream).toBe(false);
    expect(result.finalRequest).not.toHaveProperty("tools");
    // Nothing to force, so no `tool_choice` either.
    expect(result.finalRequest).not.toHaveProperty("tool_choice");
  });

  it("rejects a negative round budget instead of looping forever", async () => {
    const { client } = scriptedClient([]);
    await expect(
      runToolRounds(
        base({
          client,
          tools: { temperature: 0.2, maxRounds: -1, maxCalls: 5 } as never,
        }),
      ),
    ).rejects.toThrow(/maxRounds/);
  });
});

describe("runToolRounds — safety", () => {
  it("rejects duplicate tool call ids in one round", async () => {
    const { client } = scriptedClient([
      [
        {
          toolCalls: [
            { index: 0, id: "same", name: "search", args: "{}" },
            { index: 1, id: "same", name: "search", args: "{}" },
          ],
        },
      ],
    ]);
    await expect(
      runToolRounds(base({ client, handlers: { search: () => "ok" } })),
    ).rejects.toThrow(/duplicate tool call IDs/i);
  });

  it("rejects a tool call with no id", async () => {
    const { client } = scriptedClient([
      [{ toolCalls: [{ index: 0, name: "search", args: "{}" }] }],
    ]);
    await expect(
      runToolRounds(base({ client, handlers: { search: () => "ok" } })),
    ).rejects.toThrow(/tool call IDs/);
  });

  it("stops before the next round when the signal aborted", async () => {
    const controller = new AbortController();
    const { client } = scriptedClient([toolRound("a"), toolRound("b")]);

    await expect(
      runToolRounds(
        base({
          client,
          signal: controller.signal,
          handlers: {
            search: () => {
              controller.abort();
              return "ok";
            },
          },
        }),
      ),
    ).rejects.toThrow(RequestAbortedError);
  });
});

describe("runToolRounds — concurrency", () => {
  it("runs parallel calls of the same tool together by default", async () => {
    let active = 0;
    let peak = 0;
    const { client } = scriptedClient([
      [
        {
          toolCalls: [
            { index: 0, id: "a", name: "search", args: "{}" },
            { index: 1, id: "b", name: "search", args: "{}" },
          ],
        },
      ],
    ]);

    await runToolRounds(
      base({
        client,
        handlers: {
          search: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active -= 1;
            return "ok";
          },
        },
      }),
    );

    // No policy for this tool means no cap, so both calls overlap.
    expect(peak).toBe(2);
  });

  it("serializes calls when a concurrency limit is configured", async () => {
    let active = 0;
    let peak = 0;
    const { client } = scriptedClient([
      [
        {
          toolCalls: [
            { index: 0, id: "a", name: "search", args: "{}" },
            { index: 1, id: "b", name: "search", args: "{}" },
            { index: 2, id: "c", name: "search", args: "{}" },
          ],
        },
      ],
    ]);

    await runToolRounds(
      base({
        client,
        toolConcurrency: { search: 1 },
        handlers: {
          search: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active -= 1;
            return "ok";
          },
        },
      }),
    );

    expect(peak).toBe(1);
  });

  it("numbers repeated calls of one tool in order", async () => {
    const emit = vi.fn<(event: AgentEvent) => void>();
    const { client } = scriptedClient([
      [
        {
          toolCalls: [
            { index: 0, id: "a", name: "search", args: "{}" },
            { index: 1, id: "b", name: "search", args: "{}" },
          ],
        },
      ],
      [
        {
          toolCalls: [{ index: 0, id: "c", name: "search", args: "{}" }],
        },
      ],
    ]);

    await runToolRounds(
      base({
        client,
        emit,
        toolConcurrency: { search: 1 },
        handlers: { search: () => "ok" },
      }),
    );

    const ordinals = emit.mock.calls
      .filter((call) => call[0].type === "tool_start")
      .map((call) => {
        const event = call[0] as { callIndex: number; callTotal: number };
        return [event.callIndex, event.callTotal];
      });

    expect(ordinals).toEqual([
      [1, 2],
      [2, 2],
      [3, 3],
    ]);
  });

  it("caps callTotal at the policy maxCalls when one is declared", async () => {
    const emit = vi.fn<(event: AgentEvent) => void>();
    const { client } = scriptedClient([
      [
        {
          toolCalls: [
            { index: 0, id: "a", name: "search", args: "{}" },
            { index: 1, id: "b", name: "search", args: "{}" },
            { index: 2, id: "c", name: "search", args: "{}" },
          ],
        },
      ],
    ]);

    await runToolRounds(
      base({
        client,
        emit,
        toolConcurrency: { search: 1 },
        toolStreaming: { search: { maxCalls: 2 } },
        handlers: { search: () => "ok" },
      }),
    );

    const totals = emit.mock.calls
      .filter((call) => call[0].type === "tool_start")
      .map((call) => (call[0] as { callTotal: number }).callTotal);
    expect(totals).toEqual([2, 2, 2]);
  });
});
