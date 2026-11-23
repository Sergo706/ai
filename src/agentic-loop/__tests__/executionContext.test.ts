import { describe, expect, it, vi } from "vitest";

import type { WorkflowProgressEvent } from "../types.js";
import {
  bindStage,
  throwIfAborted,
  WorkflowAbortedError,
} from "../executionContext.js";

/**
 * Two tiny helpers, both load-bearing: every phase calls `throwIfAborted`
 * before spending money, and every progress event goes through `bindStage`.
 * A regression here either lets an aborted run keep calling models or makes the
 * UI show events with no stage.
 */

describe("WorkflowAbortedError", () => {
  it("is an Error", () => {
    expect(new WorkflowAbortedError("w")).toBeInstanceOf(Error);
  });

  it("uses a stable name so callers can branch on it", () => {
    expect(new WorkflowAbortedError("w").name).toBe("WorkflowAbortedError");
  });

  it("names the workflow in the message", () => {
    expect(new WorkflowAbortedError("opportunity").message).toBe(
      "opportunity workflow aborted by caller",
    );
  });
});

describe("throwIfAborted", () => {
  it("does nothing for an undefined signal", () => {
    expect(() => {
      throwIfAborted(undefined);
    }).not.toThrow();
  });

  it("does nothing for a live signal", () => {
    expect(() => {
      throwIfAborted(new AbortController().signal);
    }).not.toThrow();
  });

  it("throws once the signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => {
      throwIfAborted(controller.signal, "local");
    }).toThrow(WorkflowAbortedError);
  });

  it("names the workflow in the message", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => {
      throwIfAborted(controller.signal, "opportunity");
    }).toThrow(/opportunity workflow aborted/);
  });

  it("falls back to a generic workflow name", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => {
      throwIfAborted(controller.signal);
    }).toThrow(/workflow workflow aborted/);
  });
});

describe("bindStage", () => {
  it("fills in the workflow and stage on the emitted event", () => {
    const events: WorkflowProgressEvent[] = [];
    const context = bindStage(
      { workflow: "w", onProgress: (event) => events.push(event) },
      "local",
    );

    context.emit({ message: "searching", addedEvidence: false });

    expect(events[0]).toMatchObject({
      workflow: "w",
      stage: "local",
      message: "searching",
    });
  });

  it("keeps every field the caller passed", () => {
    const events: WorkflowProgressEvent[] = [];
    const context = bindStage(
      { workflow: "w", onProgress: (event) => events.push(event) },
      "external",
    );

    context.emit({
      message: "discovered",
      addedEvidence: true,
      round: 2,
      intent: "pricing",
    });

    expect(events[0]).toMatchObject({
      addedEvidence: true,
      round: 2,
      intent: "pricing",
    });
  });

  it("emits every event it is given", () => {
    const events: WorkflowProgressEvent[] = [];
    const context = bindStage(
      { workflow: "w", onProgress: (event) => events.push(event) },
      "local",
    );

    context.emit({ message: "a", addedEvidence: false });
    context.emit({ message: "b", addedEvidence: true });

    expect(events.map((event) => event.message)).toEqual(["a", "b"]);
  });

  it("tolerates a missing progress callback", () => {
    const context = bindStage({ workflow: "w" }, "local");

    expect(() => {
      context.emit({ message: "x", addedEvidence: false });
    }).not.toThrow();
  });

  it("passes the caller's signal through", () => {
    const controller = new AbortController();
    const context = bindStage(
      { workflow: "w", signal: controller.signal },
      "local",
    );

    expect(context.signal).toBe(controller.signal);
  });

  it("leaves the signal undefined when none was given", () => {
    expect(bindStage({ workflow: "w" }, "local").signal).toBeUndefined();
  });

  it("does not call the underlying callback itself", () => {
    const onProgress = vi.fn();
    bindStage({ workflow: "w", onProgress }, "local");

    // Binding must be lazy: only an emit produces an event.
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("binds independent stages without cross-talk", () => {
    const events: WorkflowProgressEvent[] = [];
    const sink = {
      workflow: "w",
      onProgress: (event: WorkflowProgressEvent) => events.push(event),
    };

    bindStage(sink, "local").emit({ message: "a", addedEvidence: false });
    bindStage(sink, "critic").emit({ message: "b", addedEvidence: false });

    expect(events.map((event) => event.stage)).toEqual(["local", "critic"]);
  });
});
