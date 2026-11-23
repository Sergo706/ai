import { describe, expect, it } from "vitest";
import { TraceCollector } from "../traceCollector.js";
import type { AgentEvent } from "../../types/ToolExecutionTypes.js";
import type { StoredToolStep } from "../../db/schema.js";

/**
 * The collector builds `messages.trace`, which is what the operator UI replays
 * after a reload. Losing a reasoning round here means a saved conversation shows
 * an answer with no reasoning, and the trace is also what the run registry
 * folds into every replayed frame.
 */

function chunk(text: string): AgentEvent {
  return { type: "chunk", text };
}

function reasoning(round: number, delta: string): AgentEvent {
  return { type: "reasoning", round, delta };
}

describe("TraceCollector", () => {
  it("starts with an empty response", () => {
    expect(new TraceCollector().fullResponse).toBe("");
  });

  it("concatenates chunks in arrival order", () => {
    const collector = new TraceCollector();
    for (const text of ["Hel", "lo ", "world"]) {
      collector.apply(chunk(text));
    }
    expect(collector.fullResponse).toBe("Hello world");
  });

  it("merges deltas within the same reasoning round", () => {
    const collector = new TraceCollector();
    collector.apply(reasoning(0, "step one "));
    collector.apply(reasoning(0, "step two"));

    expect(collector.toTrace()?.reasoning).toEqual([
      { round: 0, text: "step one step two" },
    ]);
  });

  it("keeps separate rounds in arrival order", () => {
    const collector = new TraceCollector();
    collector.apply(reasoning(0, "a"));
    collector.apply(reasoning(1, "b"));
    collector.apply(reasoning(0, "c"));

    expect(collector.toTrace()?.reasoning).toEqual([
      { round: 0, text: "ac" },
      { round: 1, text: "b" },
    ]);
  });

  it("treats a non-integer round as round zero instead of creating a NaN round", () => {
    // A provider that omits `round` would otherwise produce a `NaN` key that
    // never matches and emits one entry per delta.
    const collector = new TraceCollector();
    collector.apply({ type: "reasoning", round: 1.5, delta: "a" });
    collector.apply({
      type: "reasoning",
      round: undefined as never,
      delta: "b",
    });

    expect(collector.toTrace()?.reasoning).toEqual([{ round: 0, text: "ab" }]);
  });

  it("collects workflow progress through an extension", () => {
    // `research` is no longer a built-in section: it is the canonical example of
    // the extension hook, so this both documents the hook and keeps the
    // regression it guards (a replayed source losing its metadata).
    const research: Record<string, unknown>[] = [];
    const collector = new TraceCollector<{ research: Record<string, unknown>[] }>([
      {
        apply(event) {
          if (event.type !== "workflow_progress") return;
          research.push({
            workflow: event.workflow,
            stage: event.stage,
            addedEvidence: event.addedEvidence,
          });
        },
        toTrace() {
          return research.length > 0 ? { research } : undefined;
        },
      },
    ]);

    collector.apply({
      type: "workflow_progress",
      workflow: "research",
      stage: "external",
      addedEvidence: true,
      callIndex: 1,
      callTotal: 1,
    });

    expect(collector.toTrace()?.research).toEqual([
      {
        workflow: "research",
        stage: "external",
        addedEvidence: true,
      },
    ]);
  });

  it("keeps the run id only when the event carried one", () => {
    // An `undefined` runId in the stored trace serializes to a missing key, but
    // an explicit one must survive so a replayed source can be traced to its run.
    const research: Record<string, unknown>[] = [];
    const collector = new TraceCollector<{ research: Record<string, unknown>[] }>([
      {
        apply(event) {
          if (event.type !== "workflow_progress") return;
          research.push({
            workflow: event.workflow,
            ...(event.runId === undefined ? {} : { runId: event.runId }),
          });
        },
        toTrace() {
          return research.length > 0 ? { research } : undefined;
        },
      },
    ]);

    collector.apply({
      type: "workflow_progress",
      workflow: "research",
      stage: "external",
      addedEvidence: false,
      runId: "run-7",
      callIndex: 1,
      callTotal: 1,
    });

    expect(collector.toTrace()?.research[0]?.runId).toBe("run-7");
  });

  it("does not add a runId key when the event had none", () => {
    const research: Record<string, unknown>[] = [];
    const collector = new TraceCollector<{ research: Record<string, unknown>[] }>([
      {
        apply(event) {
          if (event.type !== "workflow_progress") return;
          research.push({
            workflow: event.workflow,
            ...(event.runId === undefined ? {} : { runId: event.runId }),
          });
        },
        toTrace() {
          return research.length > 0 ? { research } : undefined;
        },
      },
    ]);

    collector.apply({
      type: "workflow_progress",
      workflow: "research",
      stage: "external",
      addedEvidence: false,
      callIndex: 1,
      callTotal: 1,
    });

    expect(collector.toTrace()?.research[0]).not.toHaveProperty("runId");
  });

  it("appends tool steps in order", () => {
    const collector = new TraceCollector();
    const step = (name: string) =>
      ({ name, args: {}, status: "ok" }) as unknown as StoredToolStep;
    collector.addStep(step("first"));
    collector.addStep(step("second"));

    expect(
      collector.toTrace()?.steps.map((s) => (s as { name: string }).name),
    ).toEqual(["first", "second"]);
  });

  it("returns null when nothing was recorded", () => {
    // A null trace is what tells persistence not to write a `trace` column at
    // all, rather than writing an empty object.
    expect(new TraceCollector().toTrace()).toBeNull();
  });

  it("returns null when the only events were of an unhandled type", () => {
    const collector = new TraceCollector();
    collector.apply({ type: "done" } as unknown as AgentEvent);
    expect(collector.toTrace()).toBeNull();
  });

  it("returns a trace when only chunks arrived, because the response is still work", () => {
    // Text alone produces no trace sections; the null return is about the
    // sections, and `fullResponse` is stored separately.
    const collector = new TraceCollector();
    collector.apply(chunk("answer"));
    expect(collector.toTrace()).toBeNull();
    expect(collector.fullResponse).toBe("answer");
  });

  it("returns a trace when only steps were recorded", () => {
    const collector = new TraceCollector();
    collector.addStep({ name: "x" } as unknown as StoredToolStep);
    expect(collector.toTrace()).not.toBeNull();
  });

  it("returns a trace when an extension contributes one", () => {
    // Core sections alone would yield null; an extension is what makes the trace
    // non-empty, which is the whole point of the hook.
    const collector = new TraceCollector<{ research: { url: string }[] }>([
      {
        apply() {
          // No per-event work needed for this case.
        },
        toTrace() {
          return { research: [{ url: "https://a" }] };
        },
      },
    ]);

    expect(collector.toTrace()).toEqual({
      reasoning: [],
      steps: [],
      research: [{ url: "https://a" }],
    });
  });

  it("merges several extensions, later wins on a shared key", () => {
    const collector = new TraceCollector<Record<string, unknown>>([
      {
        apply() {
          // Static contribution.
        },
        toTrace() {
          return { a: 1, shared: "first" };
        },
      },
      {
        apply() {
          // Static contribution.
        },
        toTrace() {
          return { b: 2, shared: "second" };
        },
      },
    ]);

    expect(collector.toTrace()).toMatchObject({
      a: 1,
      b: 2,
      shared: "second",
    });
  });

  it("ignores an extension that contributes nothing", () => {
    const collector = new TraceCollector<Record<string, unknown>>([
      {
        apply() {
          // Observes but never contributes.
        },
        toTrace() {
          return undefined;
        },
      },
    ]);

    expect(collector.toTrace()).toBeNull();
  });

  it("exposes the same arrays it will serialize, so a caller can inspect mid-run", () => {
    const collector = new TraceCollector();
    collector.apply(reasoning(0, "x"));
    collector.addStep({ name: "s" } as unknown as StoredToolStep);

    const trace = collector.toTrace();
    expect(trace?.reasoning).toHaveLength(1);
    expect(trace?.steps).toHaveLength(1);
  });

  it("accumulates across many small chunks without dropping any", () => {
    const collector = new TraceCollector();
    const pieces = Array.from({ length: 500 }, (_, i) => String(i % 10));
    for (const piece of pieces) collector.apply(chunk(piece));
    expect(collector.fullResponse).toBe(pieces.join(""));
  });
});
