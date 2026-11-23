import { beforeEach, describe, expect, it } from "vitest";
import type { AssembledCall } from "~~/src/types/ToolExecutionTypes.js";
import { accumulateToolCall } from "../toolCalls.js";

type Delta = Parameters<typeof accumulateToolCall>[1];

function delta(partial: Record<string, unknown>): Delta {
  return partial as unknown as Delta;
}

let partials: Map<number, AssembledCall>;

beforeEach(() => {
  partials = new Map();
});

describe("accumulateToolCall", () => {
  it("creates an entry on the first fragment", () => {
    accumulateToolCall(
      partials,
      delta({
        index: 0,
        id: "call_1",
        function: { name: "search", arguments: '{"q"' },
      }),
    );
    expect(partials.get(0)).toEqual({
      id: "call_1",
      name: "search",
      arguments: '{"q"',
    });
  });

  it("appends argument fragments in arrival order", () => {
    accumulateToolCall(
      partials,
      delta({ index: 0, function: { arguments: '{"q":' } }),
    );
    accumulateToolCall(
      partials,
      delta({ index: 0, function: { arguments: '"pizza"}' } }),
    );
    expect(partials.get(0)?.arguments).toBe('{"q":"pizza"}');
  });

  it("keeps the id from the frame that carried it", () => {
    accumulateToolCall(
      partials,
      delta({ index: 0, id: "call_1", function: { name: "search" } }),
    );
    accumulateToolCall(
      partials,
      delta({ index: 0, function: { arguments: "{}" } }),
    );
    expect(partials.get(0)?.id).toBe("call_1");
  });

  it("concatenates a name that is split across frames", () => {
    accumulateToolCall(
      partials,
      delta({ index: 0, function: { name: "web_" } }),
    );
    accumulateToolCall(
      partials,
      delta({ index: 0, function: { name: "search" } }),
    );
    expect(partials.get(0)?.name).toBe("web_search");
  });

  it("does not duplicate a name some providers repeat whole on every frame", () => {
    accumulateToolCall(
      partials,
      delta({ index: 0, function: { name: "web_search" } }),
    );
    accumulateToolCall(
      partials,
      delta({ index: 0, function: { name: "web_search" } }),
    );
    accumulateToolCall(
      partials,
      delta({ index: 0, function: { name: "web_search" } }),
    );
    expect(partials.get(0)?.name).toBe("web_search");
  });

  it("tracks parallel calls by their provider index", () => {
    accumulateToolCall(
      partials,
      delta({ index: 0, id: "a", function: { name: "one" } }),
    );
    accumulateToolCall(
      partials,
      delta({ index: 1, id: "b", function: { name: "two" } }),
    );
    accumulateToolCall(
      partials,
      delta({ index: 0, function: { arguments: "{}" } }),
    );

    expect(partials.size).toBe(2);
    expect(partials.get(0)).toEqual({ id: "a", name: "one", arguments: "{}" });
    expect(partials.get(1)).toEqual({ id: "b", name: "two", arguments: "" });
  });

  it("ignores empty string fragments without dropping what it has", () => {
    accumulateToolCall(
      partials,
      delta({ index: 0, id: "a", function: { name: "one", arguments: "{}" } }),
    );
    accumulateToolCall(
      partials,
      delta({ index: 0, id: "", function: { name: "", arguments: "" } }),
    );
    expect(partials.get(0)).toEqual({ id: "a", name: "one", arguments: "{}" });
  });

  it("tolerates a frame with no function object at all", () => {
    accumulateToolCall(partials, delta({ index: 0, id: "a" }));
    expect(partials.get(0)).toEqual({ id: "a", name: "", arguments: "" });
  });

  it("accumulates a multi-megabyte argument payload without truncation", () => {
    const big = `{"body":"${"x".repeat(50_000)}"}`;
    for (let i = 0; i < big.length; i += 1_000) {
      accumulateToolCall(
        partials,
        delta({ index: 0, function: { arguments: big.slice(i, i + 1_000) } }),
      );
    }
    expect(partials.get(0)?.arguments).toBe(big);
    expect(partials.get(0)?.arguments.length).toBe(big.length);
  });

  it("does not repeat a name fragment that merely ends the accumulated name", () => {
    // Guards the `endsWith` heuristic: "search" after "web_search" is a repeat,
    // but "ch" is a genuine continuation.
    accumulateToolCall(
      partials,
      delta({ index: 0, function: { name: "web_search" } }),
    );
    accumulateToolCall(partials, delta({ index: 0, function: { name: "ch" } }));
    expect(partials.get(0)?.name).toBe("web_search");
  });
});
