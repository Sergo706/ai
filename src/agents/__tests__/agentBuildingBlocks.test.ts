import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "~~/test/test-utils/config";
import { chatCompletion, createFakeLlm } from "~~/test/test-utils/llm";
import { libLogger } from "~~/test/test-utils/logger";

/**
 * The agent building blocks: transport wrapping, signal combination, prompt
 * composition, the frame bridge, the JSON turn and the tool set.
 *
 * Only `chat.completions.create` and the MCP connector are faked — the first is
 * the paid network boundary, the second spawns a subprocess. Everything else,
 * including `executeToolLoop`, `llmSchemaParser`, `buildToolRegistry` and
 * `resolveCommonTools`, runs for real.
 */

type Utils = typeof import("../utils.js");
type ClientMod = typeof import("../client.js");
type Compose = typeof import("../composeMessages.js");
type Frames = typeof import("../frames.js");
type Tools = typeof import("../tools.js");
type Specs = typeof import("../../tools/common-tools-handlers/specs.js");
type JsonTurn = typeof import("../jsonTurn.js");
type Prompt = typeof import("../prompt.js");

interface Harness {
  utils: Utils;
  client: ClientMod;
  compose: Compose;
  frames: Frames;
  tools: Tools;
  specs: Specs;
  jsonTurn: JsonTurn;
  prompt: Prompt;
  cleanup: () => Promise<void>;
}

/** The agent modules read the provider client from the configuration. */
async function boot(): Promise<Harness> {
  const env = await loadConfig({ logger: libLogger });
  return {
    utils: (await import("../utils.js")),
    client: (await import("../client.js")),
    compose: (await import("../composeMessages.js")),
    frames: (await import("../frames.js")),
    tools: (await import("../tools.js")),
    specs: (await import("../../tools/common-tools-handlers/specs.js")),
    jsonTurn: (await import("../jsonTurn.js")),
    prompt: (await import("../prompt.js")),
    cleanup: env.cleanup,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("combineSignals", () => {
  it("returns the owned signal when the caller supplied none", async () => {
    const env = await boot();
    try {
      const owned = new AbortController().signal;
      expect(env.utils.combineSignals(undefined, owned)).toBe(owned);
    } finally {
      await env.cleanup();
    }
  });

  it("returns the caller signal when there is no owned one", async () => {
    const env = await boot();
    try {
      const caller = new AbortController().signal;
      expect(env.utils.combineSignals(caller, undefined)).toBe(caller);
    } finally {
      await env.cleanup();
    }
  });

  it("returns undefined when neither side has a signal", async () => {
    const env = await boot();
    try {
      expect(env.utils.combineSignals(undefined, undefined)).toBeUndefined();
    } finally {
      await env.cleanup();
    }
  });

  it("aborts the combined signal when the caller aborts", async () => {
    const env = await boot();
    try {
      const caller = new AbortController();
      const owned = new AbortController();

      const combined = env.utils.combineSignals(caller.signal, owned.signal);
      expect(combined?.aborted).toBe(false);

      caller.abort();
      expect(combined?.aborted).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it("aborts the combined signal when the owned run aborts", async () => {
    const env = await boot();
    try {
      const caller = new AbortController();
      const owned = new AbortController();

      const combined = env.utils.combineSignals(caller.signal, owned.signal);
      owned.abort();

      // The run's controller is how another replica stops this turn, so it has
      // to be able to stop it on its own.
      expect(combined?.aborted).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it("starts already aborted when either side is already aborted", async () => {
    const env = await boot();
    try {
      const caller = new AbortController();
      caller.abort();
      const owned = new AbortController();

      const combined = env.utils.combineSignals(caller.signal, owned.signal);

      expect(combined?.aborted).toBe(true);
    } finally {
      await env.cleanup();
    }
  });
});

describe("userContext", () => {
  it("returns an empty string when no user was supplied", async () => {
    const env = await boot();
    try {
      expect(env.utils.userContext(undefined)).toBe("");
    } finally {
      await env.cleanup();
    }
  });

  it("returns an empty string when the user carries nothing useful", async () => {
    const env = await boot();
    try {
      expect(env.utils.userContext({})).toBe("");
      expect(env.utils.userContext({ other: [] })).toBe("");
    } finally {
      await env.cleanup();
    }
  });

  it("lists every supplied field in a stable order", async () => {
    const env = await boot();
    try {
      const text = env.utils.userContext({
        locale: "en-GB",
        timezone: "Europe/London",
        geo: "GB",
        currentDate: "2025-01-02",
      });

      expect(text).toBe(
        "\n\nInformation about the user:\n" +
          "- Locale: en-GB\n" +
          "- Timezone: Europe/London\n" +
          "- Geo: GB\n" +
          "- Current time: 2025-01-02",
      );
    } finally {
      await env.cleanup();
    }
  });

  it("serializes the free-form extras", async () => {
    const env = await boot();
    try {
      const text = env.utils.userContext({ other: ["beta tester", "vip"] });
      expect(text).toContain('- Other: ["beta tester","vip"]');
    } finally {
      await env.cleanup();
    }
  });

  it("omits the heading when only empty extras were given", async () => {
    const env = await boot();
    try {
      // An empty list must not produce an "Other: []" line.
      expect(env.utils.userContext({ other: [], locale: "" })).toBe("");
    } finally {
      await env.cleanup();
    }
  });
});

describe("turnModel", () => {
  it("returns the base model untouched when the turn overrides nothing", async () => {
    const env = await boot();
    try {
      const base = { model: "base-model", temperature: 0.4 };
      expect(env.utils.turnModel(base, undefined)).toBe(base);
    } finally {
      await env.cleanup();
    }
  });

  it("folds the override over the base", async () => {
    const env = await boot();
    try {
      const result = env.utils.turnModel(
        { model: "base", temperature: 0.1 },
        { model: "turn", temperature: 0.9 },
      );

      expect(result.model).toBe("turn");
      expect(result.temperature).toBe(0.9);
    } finally {
      await env.cleanup();
    }
  });

  it("merges the nested tool settings instead of replacing them", async () => {
    const env = await boot();
    try {
      const result = env.utils.turnModel(
        { model: "base", tools: { temperature: 0.1, maxRounds: 3 } },
        { model: "turn", tools: { temperature: 0.7 } },
      );

      // A per-turn temperature must not silently drop the round cap.
      expect(result.tools).toEqual({ temperature: 0.7, maxRounds: 3 });
    } finally {
      await env.cleanup();
    }
  });

  it("merges the nested body settings and keeps the base transport", async () => {
    const env = await boot();
    try {
      const request = { timeout: 1_000 };
      const result = env.utils.turnModel(
        { model: "base", body: { top_p: 0.5 }, request },
        { model: "turn", body: { seed: 7 } },
      );

      expect(result.body).toEqual({ top_p: 0.5, seed: 7 });
      // Transport options describe the connection, not the payload, so a turn
      // cannot change them.
      expect(result.request).toBe(request);
    } finally {
      await env.cleanup();
    }
  });
});

describe("withRequestOptions", () => {
  /** A minimal client whose `create` records the options it was handed. */
  function fakeClient() {
    const create = vi.fn((body: unknown, options?: unknown) =>
      Promise.resolve({ body, options }),
    );
    const model = { name: "some-model" };
    const client = {
      chat: { completions: { create }, models: model },
    };
    return { client, create, model };
  }

  it("returns the same client when no defaults were configured", async () => {
    const env = await boot();
    try {
      const { client } = fakeClient();
      expect(env.client.withRequestOptions(client as never, undefined)).toBe(
        client,
      );
    } finally {
      await env.cleanup();
    }
  });

  it("injects the configured transport defaults into every create call", async () => {
    const env = await boot();
    try {
      const { client, create } = fakeClient();
      const wrapped = env.client.withRequestOptions(client as never, {
        timeout: 5_000,
      });

      await wrapped.chat.completions.create({ messages: [] } as never, {
        maxRetries: 2,
      });

      // Caller options win over the defaults.
      expect(create).toHaveBeenCalledWith({ messages: [] }, {
        timeout: 5_000,
        maxRetries: 2,
      });
    } finally {
      await env.cleanup();
    }
  });

  it("leaves other completion members reachable", async () => {
    const env = await boot();
    try {
      const marker = { marker: true };
      const client = {
        chat: { completions: { create: vi.fn(), models: marker } },
      };
      const wrapped = env.client.withRequestOptions(client as never, {
        timeout: 1,
      });

      // The wrapper proxies `completions` too, so an untouched member still
      // resolves through to the SDK object rather than reading as missing.
      expect(
        (wrapped.chat.completions as unknown as { models: unknown }).models,
      ).toBe(marker);
    } finally {
      await env.cleanup();
    }
  });

  it("forwards non-completions members of chat", async () => {
    const env = await boot();
    try {
      const marker = { marker: true };
      const client = {
        chat: { completions: { create: vi.fn() }, completionsMarker: marker },
      };
      const wrapped = env.client.withRequestOptions(client as never, {
        timeout: 1,
      });

      expect(
        (wrapped.chat as unknown as { completionsMarker: unknown })
          .completionsMarker,
      ).toBe(marker);
    } finally {
      await env.cleanup();
    }
  });
});

describe("composeMessages", () => {
  it("puts the system prompt first, history in the middle and the ask last", async () => {
    const env = await boot();
    try {
      const messages = env.compose.composeMessages({
        systemInstructions: "Be concise.",
        userContext: "",
        history: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "answer" },
        ],
        message: "now",
      });

      expect(messages.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
        "user",
      ]);
      expect(messages[0]).toEqual({ role: "system", content: "Be concise." });
      expect(messages[3]).toEqual({ role: "user", content: "now" });
    } finally {
      await env.cleanup();
    }
  });

  it("appends the user context to the system prompt", async () => {
    const env = await boot();
    try {
      const messages = env.compose.composeMessages({
        systemInstructions: "Be concise.",
        userContext: "\n\nInformation about the user:\n- Locale: en-GB",
        history: [],
        message: "hi",
      });

      expect(messages[0]?.content).toBe(
        "Be concise.\n\nInformation about the user:\n- Locale: en-GB",
      );
    } finally {
      await env.cleanup();
    }
  });

  it("does not mutate the history it was given", async () => {
    const env = await boot();
    try {
      const history = [{ role: "user" as const, content: "earlier" }];
      env.compose.composeMessages({
        systemInstructions: "s",
        userContext: "",
        history,
        message: "now",
      });

      expect(history).toEqual([{ role: "user", content: "earlier" }]);
    } finally {
      await env.cleanup();
    }
  });
});

describe("FrameQueue", () => {
  it("buffers frames pushed before anything is pulled", async () => {
    const env = await boot();
    try {
      const queue = new env.frames.FrameQueue();
      queue.push({ type: "chunk", text: "a" });
      queue.push({ type: "chunk", text: "b" });
      queue.close();

      const seen: unknown[] = [];
      for await (const frame of queue.frames()) seen.push(frame);

      expect(seen).toEqual([
        { type: "chunk", text: "a" },
        { type: "chunk", text: "b" },
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it("hands a live frame straight to a waiting reader", async () => {
    const env = await boot();
    try {
      const queue = new env.frames.FrameQueue();
      const iterator = queue.frames()[Symbol.asyncIterator]();

      const pending = iterator.next();
      queue.push({ type: "chunk", text: "live" });

      await expect(pending).resolves.toEqual({
        value: { type: "chunk", text: "live" },
        done: false,
      });
    } finally {
      await env.cleanup();
    }
  });

  it("resolves a waiting reader when the queue closes", async () => {
    const env = await boot();
    try {
      const queue = new env.frames.FrameQueue();
      const iterator = queue.frames()[Symbol.asyncIterator]();

      const pending = iterator.next();
      queue.close();

      await expect(pending).resolves.toEqual({ value: undefined, done: true });
    } finally {
      await env.cleanup();
    }
  });

  it("ignores a push after close instead of throwing", async () => {
    const env = await boot();
    try {
      const queue = new env.frames.FrameQueue();
      queue.close();

      expect(() => {
        queue.push({ type: "chunk", text: "late" });
      }).not.toThrow();
    } finally {
      await env.cleanup();
    }
  });

  it("closes idempotently", async () => {
    const env = await boot();
    try {
      const queue = new env.frames.FrameQueue();
      queue.close();
      expect(() => {
        queue.close();
      }).not.toThrow();
    } finally {
      await env.cleanup();
    }
  });

  it("closes when the consumer returns early", async () => {
    const env = await boot();
    try {
      const queue = new env.frames.FrameQueue();
      queue.push({ type: "chunk", text: "a" });
      const iterator = queue.frames()[Symbol.asyncIterator]();

      await iterator.next();
      await iterator.return?.(undefined);

      // After an early return the queue must be closed, so a later push is a
      // no-op rather than an unbounded leak.
      queue.push({ type: "chunk", text: "b" });
      await expect(iterator.next()).resolves.toEqual({
        value: undefined,
        done: true,
      });
    } finally {
      await env.cleanup();
    }
  });

  it("drains a completed queue then reports done", async () => {
    const env = await boot();
    try {
      const queue = new env.frames.FrameQueue();
      queue.push({ type: "chunk", text: "a" });
      queue.close();
      const iterator = queue.frames()[Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toMatchObject({ done: false });
      await expect(iterator.next()).resolves.toEqual({
        value: undefined,
        done: true,
      });
    } finally {
      await env.cleanup();
    }
  });
});

describe("framesOf", () => {
  it("replays a fixed list in order", async () => {
    const env = await boot();
    try {
      const seen: unknown[] = [];
      for await (const frame of env.frames.framesOf([
        { type: "init", conversationId: 1 },
        { type: "done" },
      ])) {
        seen.push(frame);
      }

      expect(seen).toEqual([
        { type: "init", conversationId: 1 },
        { type: "done" },
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it("reports done immediately for an empty list", async () => {
    const env = await boot();
    try {
      const iterator = env.frames.framesOf([])[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toEqual({
        value: undefined,
        done: true,
      });
    } finally {
      await env.cleanup();
    }
  });
});

describe("resolveCommonTools", () => {
  it("returns nothing for an empty selection", async () => {
    const env = await boot();
    try {
      expect(env.specs.resolveCommonTools()).toEqual([]);
      expect(env.specs.resolveCommonTools([])).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });

  it("resolves a bare name with the package defaults", async () => {
    const env = await boot();
    try {
      const [spec] = env.specs.resolveCommonTools(["calculator"]);

      expect(spec.name).toBe("calculator");
      expect(typeof spec.make).toBe("function");
      expect(spec.definitions).toMatchObject({
        type: "function",
        function: { name: "calculator" },
      });
    } finally {
      await env.cleanup();
    }
  });

  it("orders the specs by the declared defaults, not by the request", async () => {
    const env = await boot();
    try {
      const specs = env.specs.resolveCommonTools([
        "calculator",
        "get_document",
      ]);

      // `get_document` is declared first, so it must come first regardless of
      // the order the host listed them in.
      expect(specs.map((spec) => spec.name)).toEqual([
        "get_document",
        "calculator",
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it("dedupes a repeated name, keeping the last entry", async () => {
    const env = await boot();
    try {
      const specs = env.specs.resolveCommonTools([
        "calculator",
        { name: "calculator", maxCalls: 2 },
      ]);

      expect(specs).toHaveLength(1);
      expect(specs[0]?.maxCalls).toBe(2);
    } finally {
      await env.cleanup();
    }
  });

  it("keeps the built-in cache policy when the entry does not override it", async () => {
    const env = await boot();
    try {
      const [spec] = env.specs.resolveCommonTools(["get_document"]);

      expect(spec.cache).toEqual({ ttl: 3600, scoped: true });
      expect(spec.stream).toEqual({ emitResult: "none" });
    } finally {
      await env.cleanup();
    }
  });

  it("merges a partial cache override onto the defaults", async () => {
    const env = await boot();
    try {
      const [spec] = env.specs.resolveCommonTools([
        { name: "get_document", cache: { ttl: 10 } },
      ]);

      // A partial override must not drop `scoped`, which is the safety property.
      expect(spec.cache).toEqual({ ttl: 10, scoped: true });
    } finally {
      await env.cleanup();
    }
  });

  it("accepts a full cache override when the tool has no default", async () => {
    const env = await boot();
    try {
      const [spec] = env.specs.resolveCommonTools([
        { name: "calculator", cache: { ttl: 60 } },
      ]);

      expect(spec.cache).toEqual({ ttl: 60 });
    } finally {
      await env.cleanup();
    }
  });

  it("overrides the call cap and the concurrency", async () => {
    const env = await boot();
    try {
      const [spec] = env.specs.resolveCommonTools([
        { name: "extractor", maxCalls: 1, concurrency: 5 },
      ]);

      expect(spec.maxCalls).toBe(1);
      expect(spec.concurrency).toBe(5);
    } finally {
      await env.cleanup();
    }
  });

  it("omits an unset cap so the registry applies its own default", async () => {
    const env = await boot();
    try {
      const [spec] = env.specs.resolveCommonTools(["calculator"]);

      expect(spec).not.toHaveProperty("maxCalls");
      expect(spec).not.toHaveProperty("concurrency");
    } finally {
      await env.cleanup();
    }
  });

  it("lets the host supply its own handler", async () => {
    const env = await boot();
    try {
      const handler = vi.fn(async () => ({ ok: true }));
      const [spec] = env.specs.resolveCommonTools([
        { name: "calculator", make: () => handler },
      ]);

      // `make` is a factory: calling it must return the handler, not invoke it.
      const made = spec.make({ userId: "u", conversationId: 1 });
      expect(made).toBe(handler);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await env.cleanup();
    }
  });
});

describe("assembleTools", () => {
  function spec(name: string) {
    return {
      name,
      make: () => vi.fn(async () => ({ ok: true })),
      definitions: {
        type: "function" as const,
        function: { name, description: "", parameters: {} },
      },
    };
  }

  it("returns no tools when nothing was configured", async () => {
    const env = await boot();
    try {
      await expect(env.tools.assembleTools(undefined)).resolves.toEqual({
        specs: [],
        definitions: [],
        mcp: undefined,
      });
    } finally {
      await env.cleanup();
    }
  });

  it("combines the built-ins with the host specs", async () => {
    const env = await boot();
    try {
      const assembled = await env.tools.assembleTools({
        common: ["calculator"],
        specs: [spec("mine")],
      });

      expect(assembled.specs.map((entry) => entry.name)).toEqual([
        "calculator",
        "mine",
      ]);
      expect(assembled.definitions).toHaveLength(2);
      expect(assembled.mcp).toBeUndefined();
    } finally {
      await env.cleanup();
    }
  });

  it("rejects two host specs claiming one name", async () => {
    const env = await boot();
    try {
      await expect(
        env.tools.assembleTools({ specs: [spec("dup"), spec("dup")] }),
      ).rejects.toThrow('Duplicate tool name "dup" in AgentConfig.');
    } finally {
      await env.cleanup();
    }
  });

  it("rejects a host spec that shadows a built-in", async () => {
    const env = await boot();
    try {
      await expect(
        env.tools.assembleTools({
          common: ["calculator"],
          specs: [spec("calculator")],
        }),
      ).rejects.toThrow('Duplicate tool name "calculator" in AgentConfig.');
    } finally {
      await env.cleanup();
    }
  });
});

describe("bindTools", () => {
  it("binds the specs to the caller's identity", async () => {
    const env = await boot();
    try {
      const handler = vi.fn(async () => ({ ok: true }));
      const registry = env.tools.bindTools(
        [
          {
            name: "mine",
            make: () => handler,
            definitions: {
              type: "function",
              function: { name: "mine", description: "", parameters: {} },
            },
          },
        ],
        { userId: "u-1" },
      );

      const result = await registry.handlers.mine(
        {},
        { toolCallId: "c", callIndex: 1, callTotal: 1 },
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true });
      // `trackTool` is what records the call for the trace.
      expect(registry.usedTools.has("mine")).toBe(true);
      expect(registry.definitions.mine).toMatchObject({
        function: { name: "mine" },
      });
    } finally {
      await env.cleanup();
    }
  });
});

describe("buildHistoryMessages", () => {
  it("converts history without calling the model when compaction is off", async () => {
    const env = await boot();
    try {
      const llm = createFakeLlm(chatCompletion("unused"));

      const messages = await env.prompt.buildHistoryMessages({
        history: [{ id: 1, role: "user", message: "hi" }],
        state: { summary: null, throughMessageId: null },
        compaction: undefined,
        conversationId: undefined,
        client: llm.client as never,
        model: { model: "test-model" },
      });

      expect(messages).toEqual([{ role: "user", content: "hi" }]);
      expect(llm.calls).toHaveLength(0);
    } finally {
      await env.cleanup();
    }
  });
});
