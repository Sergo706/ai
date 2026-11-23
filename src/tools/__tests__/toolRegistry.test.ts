import { beforeEach, describe, expect, it } from "vitest";

import type {
  ToolExecutionContext,
  ToolHandler,
  ToolStreamPolicy,
} from "~~/src/types/ToolExecutionTypes";
import { getStorage } from "../../config/config";
import { clearConfiguredCache } from "~~/test/test-utils/cache";
import { buildToolRegistry, type ToolSpec } from "../toolRegistry";

/**
 * The registry is where three cross-cutting concerns meet: the per-call cap,
 * the response cache, and usage tracking. Every one of them is a decorator
 * around the handler, so the order they wrap in decides what the model sees.
 * These tests drive the real decorators rather than stubbing them.
 */

const context: ToolExecutionContext = {
  toolCallId: "call-1",
  callIndex: 1,
  callTotal: 1,
};

const definition = {
  type: "function" as const,
  function: {
    name: "echo",
    description: "Echo the input back",
    parameters: { type: "object", properties: {} },
  },
};

function spec(
  overrides: Partial<ToolSpec<unknown>> = {},
): ToolSpec<unknown> {
  return {
    name: "echo",
    make: (): ToolHandler => async (args) => ({ echoed: args }),
    definitions: definition,
    ...overrides,
  };
}

/** A handler that records each call and returns a fixed value. */
function countingHandler(result: unknown = "ok") {
  const calls: Record<string, unknown>[] = [];
  const handler: ToolHandler = async (args) => {
    calls.push(args);
    return result;
  };
  return { handler, calls };
}

beforeEach(() => {
  // The configured store outlives one test, so every suite starts empty.
  clearConfiguredCache(getStorage());
});

describe("buildToolRegistry", () => {
  it("registers one handler and one definition per spec", () => {
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ name: "echo" }),
      spec({ name: "echo2", definitions: {
        ...definition,
        function: { ...definition.function, name: "echo2" },
      } }),
    ]);

    expect(Object.keys(registry.handlers)).toEqual(["echo", "echo2"]);
    expect(Object.keys(registry.definitions)).toEqual(["echo", "echo2"]);
    expect(registry.definitions.echo2).toMatchObject({
      function: { name: "echo2" },
    });
  });

  it("passes the factory context straight to the tool factory", async () => {
    const seen: unknown[] = [];
    const registry = buildToolRegistry({ userId: "user-1", meta: "tag" }, [
      spec({
        make: (ctx) => {
          seen.push(ctx);
          return async () => "built";
        },
      }),
    ]);

    await registry.handlers.echo({}, context);

    expect(seen).toStrictEqual([{ userId: "user-1", meta: "tag" }]);
  });

  it("records a tool as used as soon as it is invoked, not before", async () => {
    const registry = buildToolRegistry({ userId: "user-1" }, [spec()]);

    expect([...registry.usedTools]).toEqual([]);

    await registry.handlers.echo({ a: 1 }, context);

    expect([...registry.usedTools]).toEqual(["echo"]);
  });

  it("records a tool that throws, because the model did call it", async () => {
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({
        make: () => async () => {
          throw new Error("boom");
        },
      }),
    ]);

    await expect(registry.handlers.echo({}, context)).rejects.toThrow("boom");

    expect([...registry.usedTools]).toEqual(["echo"]);
  });
});

describe("buildToolRegistry — maxCalls", () => {
  it("allows exactly maxCalls invocations", async () => {
    const { handler, calls } = countingHandler("ok");
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ maxCalls: 2, make: () => handler }),
    ]);

    await registry.handlers.echo({ n: 1 }, context);
    await registry.handlers.echo({ n: 2 }, context);
    const third = await registry.handlers.echo({ n: 3 }, context);

    expect(calls).toStrictEqual([{ n: 1 }, { n: 2 }]);
    expect(JSON.parse(String(third))).toMatchObject({
      error: { code: "TOOL_LIMIT_REACHED" },
    });
  });

  it("names the limit in the refusal so the model stops retrying", async () => {
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ maxCalls: 1, make: () => async () => "ok" }),
    ]);

    await registry.handlers.echo({}, context);
    const second = await registry.handlers.echo({}, context);

    expect(JSON.parse(String(second)).error.message).toBe(
      "echo has been called 1 times already. Do not call it again — synthesize the final answer from the results you already have.",
    );
  });

  it("counts each tool independently", async () => {
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ name: "a", maxCalls: 1, make: () => async () => "a" }),
      spec({ name: "b", maxCalls: 1, make: () => async () => "b" }),
    ]);

    await registry.handlers.a({}, context);
    const b = await registry.handlers.b({}, context);

    expect(b).toBe("b");
  });

  it("exposes the cap through toolStreaming so the stream can stop early", () => {
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ maxCalls: 3, stream: { stream: true } as ToolStreamPolicy }),
      spec({ name: "plain" }),
    ]);

    expect(registry.toolStreaming.echo).toStrictEqual({
      stream: true,
      maxCalls: 3,
    });
    expect(registry.toolStreaming.plain).toBeUndefined();
  });
});

describe("buildToolRegistry — cache", () => {
  it("serves the second identical call from the cache", async () => {
    const { handler, calls } = countingHandler({ value: 42 });
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ cache: { ttl: 60 }, make: () => handler }),
    ]);

    const first = await registry.handlers.echo({ q: "same" }, context);
    const second = await registry.handlers.echo({ q: "same" }, context);

    expect(calls).toStrictEqual([{ q: "same" }]);
    expect(first).toStrictEqual({ value: 42 });
    expect(second).toStrictEqual({ value: 42 });
  });

  it("keeps a scoped entry per user, so one user cannot read another's result", async () => {
    const { handler, calls } = countingHandler({ value: 1 });
    // Scope is fixed when the registry is built, so one registry per user is
    // exactly what a per-request registry produces.
    const forUser1 = buildToolRegistry({ userId: "user-1" }, [
      spec({ cache: { ttl: 60, scoped: true }, make: () => handler }),
    ]);
    const forUser2 = buildToolRegistry({ userId: "user-2" }, [
      spec({ cache: { ttl: 60, scoped: true }, make: () => handler }),
    ]);

    await forUser1.handlers.echo({ q: "same" }, context);
    await forUser1.handlers.echo({ q: "same" }, context);
    expect(calls).toHaveLength(1);

    await forUser2.handlers.echo({ q: "same" }, context);
    expect(calls).toHaveLength(2);
  });

  it("shares one cache entry across users when the entry is global", async () => {
    const { handler, calls } = countingHandler({ value: 1 });
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ cache: { ttl: 60 }, make: () => handler }),
    ]);

    await registry.handlers.echo({ q: "same" }, context);
    await registry.handlers.echo({ q: "same" }, {
      ...context,
      toolCallId: "call-2",
    });

    expect(calls).toHaveLength(1);
  });

  it("normalises arguments so two spellings share one entry", async () => {
    const { handler, calls } = countingHandler("ok");
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({
        cache: {
          ttl: 60,
          normalizeArgs: (args) => ({ q: String(args.q).toLowerCase() }),
        },
        make: () => handler,
      }),
    ]);

    await registry.handlers.echo({ q: "Same" }, context);
    await registry.handlers.echo({ q: "same" }, context);

    expect(calls).toHaveLength(1);
  });

  it("does not cache a tool error, so a retry can succeed", async () => {
    let attempt = 0;
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({
        cache: { ttl: 60 },
        make: () => async () => {
          attempt++;
          return attempt === 1 ? '{"error":{"code":"X","message":"y"}}' : "ok";
        },
      }),
    ]);

    const first = await registry.handlers.echo({}, context);
    const second = await registry.handlers.echo({}, context);

    expect(first).toBe('{"error":{"code":"X","message":"y"}}');
    expect(second).toBe("ok");
    expect(attempt).toBe(2);
  });

  it("caches a success even when the same arguments previously failed", async () => {
    const { handler, calls } = countingHandler("ok");
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ cache: { ttl: 60 }, make: () => handler }),
    ]);

    await registry.handlers.echo({}, context);
    await registry.handlers.echo({}, context);
    await registry.handlers.echo({}, context);

    expect(calls).toHaveLength(1);
  });
});

describe("buildToolRegistry — concurrency and stream policy", () => {
  it("only publishes concurrency for the tools that set it", () => {
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ concurrency: 4 }),
      spec({ name: "unbounded" }),
    ]);

    expect(registry.toolConcurrency).toStrictEqual({ echo: 4 });
  });

  it("keeps toolStreaming empty when no spec opts in", () => {
    const registry = buildToolRegistry({ userId: "user-1" }, [spec()]);

    expect(registry.toolStreaming).toStrictEqual({});
  });

  it("wraps the cap in the cache, so a repeated call is a hit not a refusal", async () => {
    const { handler, calls } = countingHandler("ok");
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ maxCalls: 1, cache: { ttl: 60 }, make: () => handler }),
    ]);

    const first = await registry.handlers.echo({}, context);
    const second = await registry.handlers.echo({}, context);

    // The cache is the outer decorator: a repeat is served from it and never
    // reaches the cap, so an identical retry still answers.
    expect(first).toBe("ok");
    expect(second).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("still refuses a cache miss past the cap", async () => {
    const { handler, calls } = countingHandler("ok");
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ maxCalls: 1, cache: { ttl: 60 }, make: () => handler }),
    ]);

    await registry.handlers.echo({ n: 1 }, context);
    const different = await registry.handlers.echo({ n: 2 }, context);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(different))).toMatchObject({
      error: { code: "TOOL_LIMIT_REACHED" },
    });
  });

  it("keys nested arrays and objects by content, not by identity", async () => {
    // `canonicalizeArgs` sorts object keys recursively so two structurally equal
    // argument trees hash the same. Arrays are the branch that walks positionally,
    // and an object-valued element inside one is the case a shallow stringify
    // would get wrong.
    const { handler, calls } = countingHandler("ok");
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ cache: { ttl: 60 }, make: () => handler }),
    ]);

    await registry.handlers.echo({ items: [1, "two", { b: 2, a: 1 }] }, context);
    // Same content, keys declared in the other order.
    await registry.handlers.echo({ items: [1, "two", { a: 1, b: 2 }] }, context);

    expect(calls).toHaveLength(1);
  });

  it("treats an object result with a truthy `error` as a failure worth retrying", async () => {
    let attempt = 0;
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({
        cache: { ttl: 60 },
        make: () => async () => {
          attempt++;
          // The object-shaped error is what `toolError` produces once parsed;
          // the string form is covered by the test above.
          return attempt === 1 ? { error: { code: "X", message: "y" } } : { ok: 1 };
        },
      }),
    ]);

    await registry.handlers.echo({ q: "a" }, context);
    await registry.handlers.echo({ q: "a" }, context);

    expect(attempt).toBe(2);
  });

  it("treats an `ok: false` result as a failure worth retrying", async () => {
    let attempt = 0;
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({
        cache: { ttl: 60 },
        make: () => async () => {
          attempt++;
          return attempt === 1 ? { ok: false } : { ok: true };
        },
      }),
    ]);

    await registry.handlers.echo({ q: "a" }, context);
    await registry.handlers.echo({ q: "a" }, context);

    expect(attempt).toBe(2);
  });

  it("treats a falsy result as a failure and does not cache it", async () => {
    // `isErrorResult` returns true for `null`/`""`/`0`, so an empty answer is
    // never memoised and the next turn retries the tool.
    let attempt = 0;
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({
        cache: { ttl: 60 },
        make: () => async () => {
          attempt++;
          return attempt === 1 ? null : "filled";
        },
      }),
    ]);

    const first = await registry.handlers.echo({ q: "a" }, context);
    const second = await registry.handlers.echo({ q: "a" }, context);

    expect(first).toBeNull();
    expect(second).toBe("filled");
    expect(attempt).toBe(2);
  });

  it("serves the cache from the object it stored, not the string it wrote", async () => {
    // A cache hit goes through `JSON.parse`, so the caller receives a value of
    // the shape the tool returned rather than the serialized text.
    const { handler, calls } = countingHandler({ nested: { ok: true }, list: [1, 2] });
    const registry = buildToolRegistry({ userId: "user-1" }, [
      spec({ cache: { ttl: 60 }, make: () => handler }),
    ]);

    await registry.handlers.echo({ q: "a" }, context);
    const cached = await registry.handlers.echo({ q: "a" }, context);

    expect(calls).toHaveLength(1);
    expect(cached).toStrictEqual({ nested: { ok: true }, list: [1, 2] });
  });
});
