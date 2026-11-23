import { describe, expect, it } from "vitest";
import { isTransientError } from "../transientErrors.js";

/**
 * The classification decides whether a run is retried or recorded as failed.
 * `fetch` failures arrive as `TypeError: fetch failed` with the real code on
 * `cause`, which is why the walk exists at all.
 */

describe("isTransientError", () => {
  it("recognises every socket-level code", () => {
    for (const code of [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EAI_AGAIN",
      "ENOTFOUND",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET",
    ]) {
      expect(isTransientError({ code })).toBe(true);
    }
  });

  it("recognises the retryable HTTP status codes", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 522, 524]) {
      expect(isTransientError({ status })).toBe(true);
    }
  });

  it("reads statusCode as well as status", () => {
    expect(isTransientError({ statusCode: 503 })).toBe(true);
  });

  it("treats a non-retryable status as permanent", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isTransientError({ status })).toBe(false);
    }
  });

  it("finds the real code on the cause chain of a fetch failure", () => {
    // This is the shape `fetch` throws: the outer TypeError carries only the
    // message, the socket error is the cause.
    const cause = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const err = new TypeError("fetch failed", { cause });
    expect(isTransientError(err)).toBe(true);
  });

  it("walks several levels of cause", () => {
    const root = Object.assign(new Error("deep"), { code: "ETIMEDOUT" });
    const middle = new TypeError("fetch failed", { cause: root });
    const outer = new TypeError("wrapped", { cause: middle });
    expect(isTransientError(outer)).toBe(true);
  });

  it("recognises the message-level signals even without a code", () => {
    for (const message of [
      "fetch failed",
      "socket hang up",
      "network error",
      "request timeout",
      "timed out",
      "Timed Out",
    ]) {
      expect(isTransientError(new Error(message))).toBe(true);
    }
  });

  it("does not match a message that only contains 'time' or 'out' separately", () => {
    expect(isTransientError(new Error("output was invalid"))).toBe(false);
  });

  it("treats an ordinary validation error as permanent", () => {
    expect(isTransientError(new Error("schema validation failed"))).toBe(false);
    expect(isTransientError({ code: "E_VALIDATION" })).toBe(false);
  });

  it("returns false for null, undefined and primitives", () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError("fetch failed")).toBe(false);
    expect(isTransientError(42)).toBe(false);
  });

  it("terminates on a cyclic cause chain instead of hanging", () => {
    // A self-referential cause would loop forever without the `seen` set, and a
    // hang inside an error handler is far worse than a wrong answer.
    const err = new Error("loop") as Error & { cause?: unknown };
    err.cause = err;
    expect(isTransientError(err)).toBe(false);
  });

  it("terminates on a two-node cycle", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isTransientError(a)).toBe(false);
  });

  it("ignores a cause that is a primitive", () => {
    const err = new Error("x") as Error & { cause?: unknown };
    err.cause = "just a string";
    expect(isTransientError(err)).toBe(false);
  });

  it("ignores a code that is not a string", () => {
    expect(isTransientError({ code: 42 })).toBe(false);
  });

  it("ignores a status that is not finite", () => {
    expect(isTransientError({ status: Number.NaN })).toBe(false);
    expect(isTransientError({ status: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it("prefers an inner transient code over an outer 4xx status", () => {
    // A wrapped 404 with an ECONNRESET cause is still a network failure; the
    // outer status describes the previous layer's view, not the root cause.
    const inner = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const outer = Object.assign(new Error("wrapper"), {
      status: 404,
      cause: inner,
    });
    expect(isTransientError(outer)).toBe(true);
  });
});
