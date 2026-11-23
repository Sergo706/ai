import { describe, expect, it } from "vitest";

import type { WorkflowStateSnapshot } from "../types.js";
import { WorkflowState } from "../WorkflowState.js";
import { makeState, testBudgets } from "~~/test/test-utils/agenticLoop.js";

/**
 * `WorkflowState` is the only thing a crashed run has to restore. If a field is
 * left out of `toCheckpoint` the resume silently re-does work, and if the
 * evidence window is not enforced the prompt grows without bound.
 */

describe("WorkflowState — construction", () => {
  it("seeds the pending intents with the initial query", () => {
    expect(makeState().pendingIntents).toEqual(["the query"]);
  });

  it("starts with every counter at zero", () => {
    const state = makeState();

    expect(state.localSearches).toBe(0);
    expect(state.externalRounds).toBe(0);
    expect(state.consecutiveSkippedRounds).toBe(0);
    expect(state.consecutiveRepeatedIntentRounds).toBe(0);
    expect(state.lastEvaluationRepeatCount).toBe(0);
  });

  it("starts with every flag cleared", () => {
    const state = makeState();

    expect(state.contextIsSufficient).toBe(false);
    expect(state.lastEvaluationAllRepeated).toBe(false);
    expect(state.stopReason).toBeUndefined();
  });

  it("starts with empty containers", () => {
    const state = makeState();

    expect(state.evidenceSet).toEqual([]);
    expect(state.dispatchedIntents.size).toBe(0);
    expect(state.attemptedTargets.size).toBe(0);
    expect(state.errors).toEqual([]);
  });

  it("keeps the budgets it was given", () => {
    const state = makeState();

    expect(state.budgets.maxLocalRounds).toBe(testBudgets.maxLocalRounds);
    expect(state.budgets.maxEvaluatorItems).toBe(testBudgets.maxEvaluatorItems);
  });

  it("takes the query from the constructor, not the first intent", () => {
    expect(makeState({}, "a different query").pendingIntents).toEqual([
      "a different query",
    ]);
  });
});

describe("WorkflowState — evidence window", () => {
  it("appends evidence", () => {
    const state = makeState();
    state.appendEvidence("a");

    expect(state.evidenceSet).toEqual(["a"]);
  });

  it("drops the oldest blocks past the budget", () => {
    const state = makeState({ maxEvaluatorItems: 3 });
    for (const block of ["a", "b", "c", "d", "e"]) state.appendEvidence(block);

    expect(state.evidenceSet).toEqual(["c", "d", "e"]);
  });

  it("keeps exactly the budget when one more is added", () => {
    const state = makeState({ maxEvaluatorItems: 3 });
    for (const block of ["a", "b", "c", "d"]) state.appendEvidence(block);

    expect(state.evidenceSet).toHaveLength(3);
  });

  it("keeps the newest window, not the first blocks", () => {
    const state = makeState({ maxEvaluatorItems: 2 });
    state.appendEvidence("oldest");
    state.appendEvidence("middle");
    state.appendEvidence("newest");

    // The evaluator must see what was just found, not what it already judged.
    expect(state.evidenceSet).toEqual(["middle", "newest"]);
  });

  it("honours a window of one", () => {
    const state = makeState({ maxEvaluatorItems: 1 });
    state.appendEvidence("a");
    state.appendEvidence("b");

    expect(state.evidenceSet).toEqual(["b"]);
  });
});

describe("WorkflowState — checkpoint round trip", () => {
  it("restores everything it serialised", () => {
    const original = makeState();
    original.consecutiveSkippedRounds = 1;
    original.consecutiveRepeatedIntentRounds = 2;
    original.issuedIntents.set("i1", "why");
    original.dispatchedIntents.add("i2");
    original.exhaustedIntents.set("i3", "no results");
    original.lastEvaluationAllRepeated = true;
    original.lastEvaluationRepeatCount = 4;
    original.contextIsSufficient = true;
    original.pendingIntents = ["p1", "p2"];
    original.localSearches = 3;
    original.externalRounds = 2;
    original.evidenceSet = ["e1"];
    original.localItems = ["local"];
    original.externalArtifacts = ["external"];
    original.errors = ["err"];
    original.criticNotes = "notes";
    original.discoveryFailures.set("t1", 2);
    original.failedIntents = ["f1"];
    original.seenLocalIds.add(9);
    original.attemptedTargets.add("https://a");
    original.stopReason = "budget_exhausted";

    const restored = makeState();
    restored.restore(original.toCheckpoint());

    expect(restored.toCheckpoint()).toEqual(original.toCheckpoint());
  });

  it("flattens Maps and Sets so the snapshot survives JSON", () => {
    const state = makeState();
    state.issuedIntents.set("i1", "why");
    state.dispatchedIntents.add("i2");
    state.seenLocalIds.add(7);
    state.attemptedTargets.add("https://a");

    const snapshot = state.toCheckpoint();
    const roundTripped = JSON.parse(
      JSON.stringify(snapshot),
    ) as WorkflowStateSnapshot<string, string>;

    // A Map or Set would arrive as `{}` and lose every entry.
    expect(() => {
      makeState().restore(roundTripped);
    }).not.toThrow();
  });

  it("keeps the entries after a JSON round trip", () => {
    const state = makeState();
    state.issuedIntents.set("i1", "why");
    state.seenLocalIds.add(7);

    const snapshot = JSON.parse(
      JSON.stringify(state.toCheckpoint()),
    ) as WorkflowStateSnapshot<string, string>;
    const restored = makeState();
    restored.restore(snapshot);

    expect(restored.issuedIntents.get("i1")).toBe("why");
    expect([...restored.seenLocalIds]).toEqual([7]);
  });

  it("leaves budgets out of the snapshot so a retune applies on resume", () => {
    const snapshot = makeState().toCheckpoint() as unknown as Record<
      string,
      unknown
    >;

    // Freezing budgets into the checkpoint would make a config change invisible
    // to a run that resumes after the change.
    expect(snapshot).not.toHaveProperty("budgets");
  });

  it("keeps the freshly-constructed query when the snapshot has no intents", () => {
    const partial = { ...makeState().toCheckpoint() };
    delete (partial as Partial<typeof partial>).pendingIntents;
    const target = new WorkflowState<string, string>("kept", testBudgets);
    target.restore(partial);

    // An absent field means "no opinion", not "empty".
    expect(target.pendingIntents).toEqual(["kept"]);
  });

  it("overwrites with an explicitly empty intent list", () => {
    const target = new WorkflowState<string, string>("kept", testBudgets);
    target.restore({ pendingIntents: [] });

    // `pendingIntents: []` is a real value, so it must win over the default.
    expect(target.pendingIntents).toEqual([]);
  });

  it("does not share containers with the snapshot it restored from", () => {
    const snapshot = makeState().toCheckpoint();
    const restored = makeState();
    restored.restore(snapshot);

    restored.evidenceSet.push("mutated");
    restored.issuedIntents.set("i", "v");

    expect(snapshot.evidenceSet).toEqual([]);
    expect(snapshot.issuedIntents).toEqual([]);
  });

  it("does not share containers between two restores of the same snapshot", () => {
    const snapshot = makeState().toCheckpoint();
    const first = makeState();
    const second = makeState();
    first.restore(snapshot);
    second.restore(snapshot);

    first.appendEvidence("only in first");

    expect(second.evidenceSet).toEqual([]);
  });
});

describe("WorkflowState — buildResult", () => {
  it("reports no source when nothing was collected", () => {
    expect(makeState().buildResult().source).toBe("none");
  });

  it("reports a local-only source", () => {
    const state = makeState();
    state.localItems = ["item"];

    expect(state.buildResult().source).toBe("local");
  });

  it("reports an external-only source", () => {
    const state = makeState();
    state.externalArtifacts = ["artifact"];

    expect(state.buildResult().source).toBe("external");
  });

  it("reports a mixed source when both sides contributed", () => {
    const state = makeState();
    state.localItems = ["item"];
    state.externalArtifacts = ["artifact"];

    expect(state.buildResult().source).toBe("mixed");
  });

  it("joins the evidence blocks with a separator", () => {
    const state = makeState();
    state.appendEvidence("a");
    state.appendEvidence("b");

    expect(state.buildResult().context).toBe("a\n\n---\n\nb");
  });

  it("gives a sufficient verdict priority over a recorded reason", () => {
    const state = makeState();
    state.contextIsSufficient = true;
    state.stopReason = "budget_exhausted";

    const result = state.buildResult();
    expect(result.stopReason).toBe("sufficient");
    expect(result.isSufficient).toBe(true);
  });

  it("reports the recorded stop reason when insufficient", () => {
    const state = makeState();
    state.stopReason = "aborted";

    expect(state.buildResult().stopReason).toBe("aborted");
  });

  it("defaults to budget_exhausted when no reason was recorded", () => {
    expect(makeState().buildResult().stopReason).toBe("budget_exhausted");
  });

  it("reports the pending intents as missing only when insufficient", () => {
    const state = makeState();
    state.pendingIntents = ["p1"];

    expect(state.buildResult().missingIntents).toEqual(["p1"]);

    state.contextIsSufficient = true;
    expect(state.buildResult().missingIntents).toEqual([]);
  });

  it("carries the counters through", () => {
    const state = makeState();
    state.localSearches = 4;
    state.externalRounds = 2;

    const result = state.buildResult();
    expect(result.localSearches).toBe(4);
    expect(result.externalRounds).toBe(2);
  });

  it("carries the errors through", () => {
    const state = makeState();
    state.errors.push("one failed batch");

    expect(state.buildResult().errors).toEqual(["one failed batch"]);
  });

  it("carries the report through", () => {
    const result = makeState().buildResult({ title: "report" });

    expect(result.report).toEqual({ title: "report" });
  });

  it("leaves the report undefined when none was supplied", () => {
    expect(makeState().buildResult().report).toBeUndefined();
  });

  it("markAborted sets the stop reason", () => {
    const state = makeState();
    state.markAborted();

    expect(state.buildResult().stopReason).toBe("aborted");
  });

  it("markAborted overrides an earlier stop reason", () => {
    const state = makeState();
    state.stopReason = "no_new_sources";
    state.markAborted();

    expect(state.buildResult().stopReason).toBe("aborted");
  });
});
