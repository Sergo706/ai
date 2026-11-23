import { describe, expect, it } from "vitest";
import {
  RequestAbortedError,
  responseUnavailableError,
  throwIfAborted,
} from "../errors.js";

describe("RequestAbortedError", () => {
  it("is identifiable by name so callers can rethrow it untouched", () => {
    const err = new RequestAbortedError();
    expect(err.name).toBe("RequestAbortedError");
    expect(err).toBeInstanceOf(Error);
  });

  it("says the client aborted, not that the server failed", () => {
    expect(new RequestAbortedError().message).toMatch(/aborted by the client/);
  });
});

describe("responseUnavailableError", () => {
  it("returns a fresh error each time so the stack points at the caller", () => {
    const first = responseUnavailableError();
    const second = responseUnavailableError();
    expect(first).not.toBe(second);
  });

  it("does not leak the provider error or cause to the user", () => {
    const err = responseUnavailableError();
    expect(err.cause).toBeUndefined();
    expect(err.message).toBe(
      "Unable to complete the response. Please try again.",
    );
    expect(err.message).not.toMatch(/openai|deepseek|token|trace/i);
  });
});

describe("throwIfAborted", () => {
  it("does nothing when no signal was supplied", () => {
    expect(() => {
      throwIfAborted(undefined);
    }).not.toThrow();
  });

  it("does nothing while the signal is live", () => {
    const controller = new AbortController();
    expect(() => {
      throwIfAborted(controller.signal);
    }).not.toThrow();
  });

  it("throws once the signal has fired", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => {
      throwIfAborted(controller.signal);
    }).toThrow(RequestAbortedError);
  });

  it("throws when the run was cancelled with a reason", () => {
    const controller = new AbortController();
    controller.abort(new Error("stop button"));
    expect(() => {
      throwIfAborted(controller.signal);
    }).toThrow(RequestAbortedError);
  });
});
