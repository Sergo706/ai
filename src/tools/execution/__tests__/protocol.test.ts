import { describe, expect, it } from "vitest";
import {
  isErrorPayload,
  normalizeConcurrency,
  parseToolArguments,
  serializeToolResult,
  toolError,
  truncateForPreview,
  validateBudgets,
} from "../protocol.js";

/**
 * These helpers sit between the model and the tool handlers. A wrong answer does
 * not crash: it silently turns an argument into `undefined`, or a tool result
 * into a string the model reads as data.
 */

describe("toolError", () => {
  it("produces a JSON payload with a code and a message", () => {
    expect(JSON.parse(toolError("BAD", "it broke"))).toEqual({
      error: { code: "BAD", message: "it broke" },
    });
  });

  it("is recognised by isErrorPayload", () => {
    expect(isErrorPayload(toolError("X", "y"))).toBe(true);
  });
});

describe("isErrorPayload", () => {
  it("does not treat ordinary JSON as an error", () => {
    expect(isErrorPayload(JSON.stringify({ ok: true }))).toBe(false);
    expect(isErrorPayload("")).toBe(false);
    expect(isErrorPayload("[1,2,3]")).toBe(false);
  });

  it("does not treat prose that mentions an error as an error payload", () => {
    expect(isErrorPayload('{"errors":[]}')).toBe(false);
    expect(isErrorPayload('an error: {"error":')).toBe(false);
  });
});

describe("parseToolArguments", () => {
  it("parses valid JSON", () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments("[1,2]")).toEqual([1, 2]);
    expect(parseToolArguments("null")).toBeNull();
  });

  it("returns undefined for malformed JSON instead of throwing", () => {
    // The model does occasionally emit a truncated argument string, and the
    // loop converts `undefined` into a validation error for the tool.
    expect(parseToolArguments("{")).toBeUndefined();
    expect(parseToolArguments("")).toBeUndefined();
    expect(parseToolArguments("undefined")).toBeUndefined();
  });
});

describe("serializeToolResult", () => {
  it("passes a string through unchanged", () => {
    expect(serializeToolResult("hello")).toBe("hello");
  });

  it("JSON-encodes an object", () => {
    expect(serializeToolResult({ a: 1 })).toBe('{"a":1}');
  });

  it("encodes numbers and booleans", () => {
    expect(serializeToolResult(0)).toBe("0");
    expect(serializeToolResult(false)).toBe("false");
  });

  it("returns an error payload for undefined, which JSON.stringify drops", () => {
    // `JSON.stringify(undefined)` is `undefined`, and returning that would make
    // the loop push a non-string into the message history.
    const result = serializeToolResult(undefined);
    expect(isErrorPayload(result)).toBe(true);
    expect(JSON.parse(result)).toEqual({
      error: {
        code: "INVALID_TOOL_RESULT",
        message: "Handler returned no serializable result.",
      },
    });
  });

  it("returns an error payload for a function, which serializes to nothing", () => {
    const result = serializeToolResult(() => {});
    expect(isErrorPayload(result)).toBe(true);
  });

  it("encodes null as the JSON null literal, not as an error", () => {
    expect(serializeToolResult(null)).toBe("null");
  });

  it("serializes a Map as an empty object, matching JSON semantics", () => {
    expect(serializeToolResult(new Map([["a", 1]]))).toBe("{}");
  });
});

describe("truncateForPreview", () => {
  it("returns an empty string in none mode", () => {
    expect(truncateForPreview("anything", "none")).toBe("");
  });

  it("returns the value unchanged in full mode, however long", () => {
    const long = "x".repeat(10_000);
    expect(truncateForPreview(long, "full")).toBe(long);
  });

  it("keeps a short value intact in preview mode", () => {
    expect(truncateForPreview("short", "preview")).toBe("short");
  });

  it("cuts a long value to the preview budget", () => {
    const long = "y".repeat(1_000);
    const preview = truncateForPreview(long, "preview");
    expect(preview).toHaveLength(300);
    expect(preview).toBe(long.slice(0, 300));
  });

  it("keeps exactly the budget, not one character less", () => {
    expect(truncateForPreview("z".repeat(300), "preview")).toHaveLength(300);
    expect(truncateForPreview("z".repeat(301), "preview")).toHaveLength(300);
  });
});

describe("normalizeConcurrency", () => {
  it("treats an absent limit as unbounded", () => {
    expect(normalizeConcurrency(undefined)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("treats a non-positive limit as unbounded rather than as zero", () => {
    // Zero parallel calls would hang the loop; unbounded is the documented
    // meaning of "no limit".
    expect(normalizeConcurrency(0)).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizeConcurrency(-1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("floors a fractional limit", () => {
    expect(normalizeConcurrency(2.9)).toBe(2);
  });

  it("clamps a fraction below one to one rather than zero", () => {
    expect(normalizeConcurrency(0.5)).toBe(1);
  });

  it("treats NaN and Infinity as unbounded", () => {
    expect(normalizeConcurrency(Number.NaN)).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizeConcurrency(Number.POSITIVE_INFINITY)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("passes a normal limit through", () => {
    expect(normalizeConcurrency(4)).toBe(4);
  });
});

describe("validateBudgets", () => {
  it("accepts non-negative safe integers", () => {
    expect(() => {
      validateBudgets(3, 10);
    }).not.toThrow();
    expect(() => {
      validateBudgets(0, 0);
    }).not.toThrow();
  });

  it("rejects a negative round budget", () => {
    expect(() => {
      validateBudgets(-1, 10);
    }).toThrow(RangeError);
  });

  it("rejects a negative call budget", () => {
    expect(() => {
      validateBudgets(1, -1);
    }).toThrow(RangeError);
  });

  it("rejects a fractional budget", () => {
    expect(() => {
      validateBudgets(1.5, 10);
    }).toThrow(RangeError);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => {
      validateBudgets(Number.NaN, 1);
    }).toThrow(RangeError);
    expect(() => {
      validateBudgets(1, Number.POSITIVE_INFINITY);
    }).toThrow(RangeError);
  });

  it("names the offending parameter, so the caller can fix the right one", () => {
    expect(() => {
      validateBudgets(-1, 5);
    }).toThrow(/maxRounds/);
    expect(() => {
      validateBudgets(1, -5);
    }).toThrow(/maxCalls/);
  });
});
