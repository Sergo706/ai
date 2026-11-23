import { describe, expect, it, vi } from "vitest";
import type {
  ToolCall,
  ToolExecutionContext,
} from "~~/src/types/ToolExecutionTypes.js";
import { executeToolCall } from "../executeCall.js";

const context: ToolExecutionContext = {
  toolCallId: "call_1",
  callIndex: 1,
  callTotal: 1,
};

function call(name: string, args: string, type = "function"): ToolCall {
  return {
    id: "call_1",
    type,
    function: { name, arguments: args },
  } as ToolCall;
}

const allowed = new Set(["search"]);

describe("executeToolCall", () => {
  it("runs the handler and serializes its result", async () => {
    const handler = vi.fn(() => ({ hits: 3 }));
    const out = await executeToolCall(
      call("search", '{"q":"pizza"}'),
      allowed,
      undefined,
      { search: handler },
      context,
    );
    expect(handler).toHaveBeenCalledWith({ q: "pizza" }, context);
    expect(JSON.parse(out)).toEqual({ hits: 3 });
  });

  it("passes the parsed arguments and the execution context through", async () => {
    const handler = vi.fn(
      (_args: Record<string, unknown>, ctx: ToolExecutionContext) =>
        ctx.toolCallId,
    );
    await executeToolCall(
      call("search", "{}"),
      allowed,
      undefined,
      { search: handler },
      context,
    );
    expect(handler.mock.calls[0]?.[1]).toEqual(context);
  });

  it("rejects a non-function tool type", async () => {
    const out = await executeToolCall(
      call("search", "{}", "retrieval"),
      allowed,
      undefined,
      { search: vi.fn() },
      context,
    );
    expect(JSON.parse(out).error.code).toBe("UNSUPPORTED_TOOL_TYPE");
  });

  it("refuses to run a tool the caller never advertised", async () => {
    const handler = vi.fn();
    const out = await executeToolCall(
      call("delete_everything", "{}"),
      allowed,
      undefined,
      { delete_everything: handler },
      context,
    );
    expect(JSON.parse(out).error.code).toBe("UNKNOWN_TOOL");
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not treat an inherited object key as an advertised tool", async () => {
    const out = await executeToolCall(
      call("toString", "{}"),
      new Set(["toString"]),
      undefined,
      undefined,
      context,
    );
    expect(JSON.parse(out).error.code).toBe("MISSING_HANDLER");
  });

  it("rejects unparseable arguments", async () => {
    const handler = vi.fn();
    const out = await executeToolCall(
      call("search", "{not json"),
      allowed,
      undefined,
      { search: handler },
      context,
    );
    expect(JSON.parse(out).error.code).toBe("INVALID_ARGUMENTS");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a JSON array as the argument object", async () => {
    const out = await executeToolCall(
      call("search", "[1,2]"),
      allowed,
      undefined,
      { search: vi.fn() },
      context,
    );
    expect(JSON.parse(out).error.code).toBe("INVALID_ARGUMENTS");
  });

  it("rejects a JSON null argument object", async () => {
    const out = await executeToolCall(
      call("search", "null"),
      allowed,
      undefined,
      { search: vi.fn() },
      context,
    );
    expect(JSON.parse(out).error.code).toBe("INVALID_ARGUMENTS");
  });

  it("reports a missing handler when neither executor nor handler exists", async () => {
    const out = await executeToolCall(
      call("search", "{}"),
      allowed,
      undefined,
      undefined,
      context,
    );
    expect(JSON.parse(out).error.code).toBe("MISSING_HANDLER");
  });

  it("uses the executor when both are supplied", async () => {
    const executor = vi.fn(() => "from-executor");
    const handler = vi.fn(() => "from-handler");
    const out = await executeToolCall(
      call("search", "{}"),
      allowed,
      executor,
      { search: handler },
      context,
    );
    expect(out).toBe("from-executor");
    expect(handler).not.toHaveBeenCalled();
  });

  it("turns a thrown handler into an error payload instead of propagating", async () => {
    const out = await executeToolCall(
      call("search", "{}"),
      allowed,
      undefined,
      {
        search: () => {
          throw new Error("database on fire");
        },
      },
      context,
    );
    const parsed = JSON.parse(out).error;
    expect(parsed.code).toBe("TOOL_EXECUTION_FAILED");
    expect(parsed.message).not.toContain("database on fire");
  });

  it("turns a rejected async executor into an error payload", async () => {
    const out = await executeToolCall(
      call("search", "{}"),
      allowed,
      async () => {
        throw new Error("timeout");
      },
      undefined,
      context,
    );
    expect(JSON.parse(out).error.code).toBe("TOOL_EXECUTION_FAILED");
  });

  it("reports a handler that returned nothing serializable", async () => {
    const out = await executeToolCall(
      call("search", "{}"),
      allowed,
      undefined,
      { search: () => undefined },
      context,
    );
    expect(JSON.parse(out).error.code).toBe("INVALID_TOOL_RESULT");
  });

  it("passes a string result through unchanged", async () => {
    const out = await executeToolCall(
      call("search", "{}"),
      allowed,
      undefined,
      { search: () => "plain text result" },
      context,
    );
    expect(out).toBe("plain text result");
  });

  it("serializes a string handler result already shaped as JSON", async () => {
    const out = await executeToolCall(
      call("search", "{}"),
      allowed,
      undefined,
      { search: () => '{"already":"json"}' },
      context,
    );
    expect(out).toBe('{"already":"json"}');
  });
});

describe("executeToolCall — serializeForModel", () => {
  it("uses the formatter for a structured result", async () => {
    const out = await executeToolCall(
      call("search", "{}"),
      allowed,
      undefined,
      { search: () => ({ hits: 3 }) },
      context,
      () => "- **hits**: 3",
    );
    expect(out).toBe("- **hits**: 3");
  });

  it("receives the raw handler result, not the serialized one", async () => {
    const serialize = vi.fn(() => "rendered");
    const payload = { hits: 3 };
    await executeToolCall(
      call("search", "{}"),
      allowed,
      undefined,
      { search: () => payload },
      context,
      serialize,
    );
    expect(serialize).toHaveBeenCalledWith(payload);
  });

  it("never rewrites a string result, so error envelopes survive", async () => {
    const serialize = vi.fn(() => "CLOBBERED");
    const out = await executeToolCall(
      call("search", "{}"),
      allowed,
      undefined,
      { search: () => '{"error":{"code":"X","message":"y"}}' },
      context,
      serialize,
    );
    expect(out).toBe('{"error":{"code":"X","message":"y"}}');
    expect(serialize).not.toHaveBeenCalled();
  });

  it("falls back to JSON when the formatter throws", async () => {
    const out = await executeToolCall(
      call("search", "{}"),
      allowed,
      undefined,
      { search: () => ({ hits: 3 }) },
      context,
      () => {
        throw new Error("formatter exploded");
      },
    );
    expect(JSON.parse(out)).toEqual({ hits: 3 });
  });

  it("falls back to JSON when the formatter returns blank", async () => {
    const out = await executeToolCall(
      call("search", "{}"),
      allowed,
      undefined,
      { search: () => ({ hits: 3 }) },
      context,
      () => "   ",
    );
    expect(JSON.parse(out)).toEqual({ hits: 3 });
  });

  it("leaves the default JSON path untouched when no formatter is set", async () => {
    const out = await executeToolCall(
      call("search", "{}"),
      allowed,
      undefined,
      { search: () => ({ hits: 3 }) },
      context,
    );
    expect(out).toBe('{"hits":3}');
  });
});
