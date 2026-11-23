import { describe, expect, it, vi } from "vitest";

import type {
  EvaluatorVerdict,
  ExternalDiscoveryAdapter,
  TargetExecutorAdapter,
} from "../types.js";
import type { DiscoveredPayload } from "~~/test/test-utils/agenticLoop.js";
import { EvaluatorPhase } from "../phases/EvaluatorPhase.js";
import { ExternalDiscoveryPhase } from "../phases/ExternalDiscoveryPhase.js";
import { WorkflowAbortedError } from "../executionContext.js";
import {
  ctx,
  discoveryHarness,
  makeLogger,
  makeState,
  scriptedEvaluator,
  testBudgets,
} from "~~/test/test-utils/agenticLoop.js";

/**
 * The external phase spends the run's real budget: every round costs paid
 * discovery calls and crawls. Its guards decide when to stop paying, so each
 * one is pinned: no intents, all intents exhausted, no new targets, repeated
 * intents, discovery failures, and a satisfied evaluator.
 */

describe("ExternalDiscoveryPhase", () => {
  function build(
    options: {
      discover?: (intent: string) => Promise<DiscoveredPayload>;
      extractCandidates?: (
        intent: string,
        payload: DiscoveredPayload,
      ) => string[];
      extractPassiveEvidence?: (
        intent: string,
        payload: DiscoveredPayload,
      ) => string[];
      isBlocked?: (target: string) => { blocked: boolean; reason?: string };
      executeBatch?: (
        targets: string[],
        state: ReturnType<typeof makeState<string, string>>,
      ) => Promise<boolean>;
      verdicts?: EvaluatorVerdict[];
      stateOverrides?: Partial<typeof testBudgets>;
    } = {},
  ) {
    const state = makeState(options.stateOverrides);
    const harness = discoveryHarness(options);
    const evaluator = scriptedEvaluator(options.verdicts ?? []);
    const evaluatorPhase = new EvaluatorPhase<string, string>(
      "w",
      "q",
      evaluator.adapter,
      state,
      makeLogger(),
    );
    const phase = new ExternalDiscoveryPhase<
      string,
      DiscoveredPayload,
      string,
      string
    >(
      "w",
      harness.discovery,
      harness.executor,
      state,
      evaluatorPhase,
      makeLogger(),
    );

    return { phase, state, evaluator, ...harness };
  }

  describe("runSeeds", () => {
    it("does nothing when there are no seeds", async () => {
      const { phase, executeBatch } = build();

      await phase.runSeeds([], ctx());

      expect(executeBatch).not.toHaveBeenCalled();
    });

    it("executes the seeds and evaluates when they yield evidence", async () => {
      const { phase, state, executeBatch, evaluator } = build({
        verdicts: [{ isSufficient: false, nextIntents: ["x"] }],
      });

      await phase.runSeeds(["https://a.test"], ctx());

      expect(executeBatch).toHaveBeenCalledTimes(1);
      expect(evaluator.calls).toBe(1);
      expect(state.evidenceSet).toEqual(["evidence https://a.test"]);
    });

    it("skips the evaluator when the seeds yield no evidence", async () => {
      const { phase, evaluator } = build({
        executeBatch: vi.fn(async () => false),
      });

      await phase.runSeeds(["https://a.test"], ctx());

      expect(evaluator.calls).toBe(0);
    });

    it("drops already-attempted seeds without calling the executor", async () => {
      const { phase, state, executeBatch } = build();
      state.attemptedTargets.add("https://a.test");

      await phase.runSeeds(["https://a.test"], ctx());

      expect(executeBatch).not.toHaveBeenCalled();
    });

    it("drops blocked seeds", async () => {
      const { phase, executeBatch } = build({
        isBlocked: (target) => ({ blocked: target === "https://bad.test" }),
      });

      await phase.runSeeds(["https://bad.test"], ctx());

      expect(executeBatch).not.toHaveBeenCalled();
    });

    it("executes only the seeds that survive filtering", async () => {
      const { phase, executeBatch } = build({
        isBlocked: (target) => ({ blocked: target === "https://bad.test" }),
      });

      await phase.runSeeds(["https://bad.test", "https://good.test"], ctx());

      expect(executeBatch).toHaveBeenCalledWith(
        ["https://good.test"],
        expect.anything(),
        expect.anything(),
      );
    });

    it("marks surviving seeds as attempted so a later round cannot redo them", async () => {
      const { phase, state } = build();

      await phase.runSeeds(["https://a.test"], ctx());

      expect(state.attemptedTargets.has("https://a.test")).toBe(true);
    });

    it("records sufficiency from the seed evaluation", async () => {
      const { phase, state } = build({
        verdicts: [{ isSufficient: true, nextIntents: [] }],
      });

      await phase.runSeeds(["https://a.test"], ctx());

      expect(state.contextIsSufficient).toBe(true);
    });
  });

  describe("runRounds — budgeting", () => {
    it("dispatches one discovery call per pending intent", async () => {
      const { phase, state, discover } = build({
        stateOverrides: { maxExternalRounds: 1 },
      });
      state.pendingIntents = ["alpha", "beta"];

      await phase.runRounds(ctx());

      expect(discover).toHaveBeenCalledTimes(2);
      expect(discover.mock.calls.map((call) => call[0])).toEqual([
        "alpha",
        "beta",
      ]);
      expect(state.externalRounds).toBe(1);
    });

    it("caps the intents per round", async () => {
      const { phase, state, discover } = build({
        stateOverrides: { maxIntentsPerRound: 2, maxExternalRounds: 1 },
      });
      state.pendingIntents = ["a", "b", "c"];

      await phase.runRounds(ctx());

      expect(discover).toHaveBeenCalledTimes(2);
      expect(discover.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
    });

    it("caps the targets per intent", async () => {
      const { phase, state, executeBatch } = build({
        discover: async () => ({ targets: ["t1", "t2", "t3"] }),
        stateOverrides: { maxTargetsPerIntent: 2, maxExternalRounds: 1 },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(executeBatch).toHaveBeenCalledWith(
        ["t1", "t2"],
        expect.anything(),
        expect.anything(),
      );
    });

    it("stops at maxExternalRounds when nothing else fires", async () => {
      const { phase, state, discover } = build({
        verdicts: [{ isSufficient: false, nextIntents: ["fresh"] }],
        stateOverrides: {
          maxExternalRounds: 2,
          maxSkippedExternalRounds: 99,
          maxRepeatedIntentRounds: 99,
        },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(state.externalRounds).toBeLessThanOrEqual(2);
      expect(discover).toHaveBeenCalled();
    });

    it("honours a resume round offset", async () => {
      const { phase, discover } = build({
        stateOverrides: { maxExternalRounds: 4 },
      });

      await phase.runRounds(ctx(), { startRound: 3 });

      expect(discover).toHaveBeenCalledTimes(1);
    });
  });

  describe("runRounds — stopping", () => {
    it("stops when there are no pending intents at all", async () => {
      const { phase, state } = build();
      state.pendingIntents = [];

      await phase.runRounds(ctx());

      // Regression: the reason used to be left unset, which `buildResult`
      // turns into "budget_exhausted" even though nothing ran out.
      expect(state.stopReason).toBe("no_new_sources");
      expect(state.externalRounds).toBe(1);
    });

    it("never pays for a discovery call on an exhausted intent", async () => {
      const { phase, state, discover } = build();
      state.pendingIntents = ["alpha"];
      state.exhaustedIntents.set(phaseFingerprint(state, "alpha"), "alpha");

      await phase.runRounds(ctx());

      expect(discover).not.toHaveBeenCalled();
      expect(state.stopReason).toBe("no_new_sources");
    });

    it("dispatches the intents that are not exhausted", async () => {
      const { phase, state, discover } = build({
        stateOverrides: { maxExternalRounds: 1 },
      });
      state.pendingIntents = ["spent", "fresh"];
      state.exhaustedIntents.set(phaseFingerprint(state, "spent"), "spent");

      await phase.runRounds(ctx());

      expect(discover.mock.calls.map((call) => call[0])).toEqual(["fresh"]);
    });

    it("stops once the evaluator is satisfied", async () => {
      const { phase, state } = build({
        discover: async () => ({ targets: ["t1"] }),
        verdicts: [{ isSufficient: true, nextIntents: [] }],
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(state.externalRounds).toBe(1);
      expect(state.contextIsSufficient).toBe(true);
    });

    it("gives up after consecutive rounds that discover nothing new", async () => {
      const { phase, state, discover } = build({
        discover: async () => ({ targets: ["same"] }),
        executeBatch: vi.fn(async () => false),
        stateOverrides: {
          maxSkippedExternalRounds: 2,
          maxExternalRounds: 6,
          maxRepeatedIntentRounds: 99,
        },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(state.stopReason).toBe("no_new_sources");
      expect(state.externalRounds).toBeLessThan(6);
      expect(discover).toHaveBeenCalled();
    });

    it("gives up when the evaluator keeps re-issuing searched intents", async () => {
      const { phase, state } = build({
        discover: async () => ({ targets: ["t1"] }),
        verdicts: [{ isSufficient: false, nextIntents: ["alpha"] }],
        stateOverrides: { maxRepeatedIntentRounds: 2, maxExternalRounds: 8 },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(state.stopReason).toBe("no_new_sources");
      expect(state.externalRounds).toBeLessThan(8);
    });

    it("retries the same target key only once even if rediscovered", async () => {
      const { phase, state, executeBatch } = build({
        discover: async () => ({ targets: ["t1"] }),
        stateOverrides: {
          maxExternalRounds: 3,
          maxSkippedExternalRounds: 99,
          maxRepeatedIntentRounds: 99,
        },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      // t1 was attempted in round 1, so later rounds cannot re-execute it.
      expect(executeBatch).toHaveBeenCalledTimes(1);
    });

    it("resets the skipped-round streak when a round executes something", async () => {
      let round = 0;
      const { phase, state } = build({
        discover: async () => {
          round++;
          return { targets: [`t${String(round)}`] };
        },
        stateOverrides: {
          maxExternalRounds: 3,
          maxSkippedExternalRounds: 2,
          maxRepeatedIntentRounds: 99,
        },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(state.consecutiveSkippedRounds).toBe(0);
    });
  });

  describe("runRounds — evidence", () => {
    it("records passive evidence without triggering the evaluator", async () => {
      const { phase, state, evaluator } = build({
        discover: async () => ({ targets: [], passive: ["side note"] }),
        extractPassiveEvidence: (_intent, payload) => payload.passive ?? [],
        executeBatch: vi.fn(async () => false),
        stateOverrides: { maxExternalRounds: 1 },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(state.evidenceSet).toEqual(["side note"]);
      expect(evaluator.calls).toBe(0);
    });

    it("ignores a whitespace-only passive block", async () => {
      const { phase, state } = build({
        discover: async () => ({ targets: [], passive: ["   "] }),
        extractPassiveEvidence: (_intent, payload) => payload.passive ?? [],
        executeBatch: vi.fn(async () => false),
        stateOverrides: { maxExternalRounds: 1 },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(state.evidenceSet).toEqual([]);
    });

    it("records passive evidence before the target evidence", async () => {
      const { phase, state } = build({
        discover: async () => ({ targets: ["t1"], passive: ["overview"] }),
        extractPassiveEvidence: (_intent, payload) => payload.passive ?? [],
        stateOverrides: { maxExternalRounds: 1 },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(state.evidenceSet).toEqual(["overview", "evidence t1"]);
    });

    it("marks an intent as dispatched only after settlement", async () => {
      const { phase, state } = build({
        discover: async () => {
          throw new Error("nope");
        },
        stateOverrides: { maxExternalRounds: 1 },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      // A failed dispatch must stay retryable, so it cannot be dispatched.
      expect(state.dispatchedIntents.size).toBe(0);
    });
  });

  describe("runRounds — failures", () => {
    it("records a failed intent in the current round's error list", async () => {
      const { phase, state } = build({
        discover: async () => {
          throw new Error("serp down");
        },
        stateOverrides: { maxExternalRounds: 1 },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(state.errors).toEqual([`Search failed for "alpha": serp down`]);
      expect(state.failedIntents).toEqual(["alpha"]);
    });

    it("keeps retrying an intent that has not hit the failure limit", async () => {
      const { phase, state, discover } = build({
        discover: async () => {
          throw new Error("serp down");
        },
        stateOverrides: {
          maxDiscoveryFailuresPerIntent: 3,
          maxExternalRounds: 2,
          maxSkippedExternalRounds: 99,
          maxRepeatedIntentRounds: 99,
        },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(discover).toHaveBeenCalledTimes(2);
      expect(state.exhaustedIntents.size).toBe(0);
    });

    it("exhausts an intent after the configured number of failures", async () => {
      const { phase, state } = build({
        discover: async () => {
          throw new Error("serp down");
        },
        stateOverrides: {
          maxDiscoveryFailuresPerIntent: 2,
          maxExternalRounds: 3,
          maxSkippedExternalRounds: 99,
          maxRepeatedIntentRounds: 99,
        },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect([...state.exhaustedIntents.values()]).toEqual(["alpha"]);
    });

    it("clears the failure counter once the intent finally dispatches", async () => {
      let attempts = 0;
      const { phase, state } = build({
        discover: async () => {
          attempts++;
          if (attempts === 1) throw new Error("transient");
          return { targets: ["t1"] };
        },
        stateOverrides: {
          maxDiscoveryFailuresPerIntent: 3,
          maxExternalRounds: 2,
          maxSkippedExternalRounds: 99,
          maxRepeatedIntentRounds: 99,
        },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(state.discoveryFailures.size).toBe(0);
      expect(state.dispatchedIntents.size).toBe(1);
    });

    it("caps the stored error message so one bad payload cannot flood the state", async () => {
      const long = "x".repeat(500);
      const { phase, state } = build({
        discover: async () => {
          throw new Error(long);
        },
        stateOverrides: { maxExternalRounds: 1 },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(state.errors[0].length).toBeLessThan(long.length);
    });

    it("survives a rejection from one intent and still processes the others", async () => {
      const { phase, state } = build({
        discover: async (intent: string) => {
          if (intent === "bad") throw new Error("nope");
          return { targets: [`${intent}-target`] };
        },
        stateOverrides: { maxExternalRounds: 1 },
      });
      state.pendingIntents = ["bad", "good"];

      await phase.runRounds(ctx());

      expect(state.evidenceSet).toContain("evidence good-target");
      // Only the failing intent is recorded; the healthy one is not blamed.
      expect(state.errors).toHaveLength(1);
      expect(state.errors[0]).toContain('"bad"');
    });

    it("treats a failure while processing results as a soft error", async () => {
      const { phase, state } = build({
        discover: async () => ({ targets: ["t1"] }),
        extractCandidates: () => {
          throw new Error("bad payload");
        },
        stateOverrides: { maxExternalRounds: 1 },
      });
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(state.errors).toEqual([`Search failed for "alpha": bad payload`]);
      expect(state.failedIntents).toEqual(["alpha"]);
    });
  });

  describe("runRounds — checkpointing", () => {
    it("fires onRoundComplete with the round counter", async () => {
      const { phase, state } = build({
        stateOverrides: { maxExternalRounds: 2, maxSkippedExternalRounds: 99 },
      });
      state.pendingIntents = ["alpha"];
      const onRoundComplete = vi.fn();

      await phase.runRounds(ctx(), { onRoundComplete });

      expect(onRoundComplete).toHaveBeenCalled();
      expect(onRoundComplete.mock.calls[0][0]).toBeGreaterThan(0);
    });

    it("does not require a checkpoint callback", async () => {
      const { phase, state } = build({
        stateOverrides: { maxExternalRounds: 1 },
      });
      state.pendingIntents = ["alpha"];

      await expect(phase.runRounds(ctx())).resolves.toBeUndefined();
    });
  });

  describe("abort", () => {
    it("aborts between rounds", async () => {
      const controller = new AbortController();
      const { phase, state } = build({
        discover: async () => {
          controller.abort();
          return { targets: [] };
        },
        stateOverrides: { maxExternalRounds: 5 },
      });
      state.pendingIntents = ["alpha"];

      await expect(phase.runRounds(ctx(controller.signal))).rejects.toThrow(
        WorkflowAbortedError,
      );
    });

    it("re-throws an abort that arrives during discovery", async () => {
      const controller = new AbortController();
      const { phase, state } = build({
        discover: async () => {
          controller.abort();
          throw new Error("socket closed");
        },
        stateOverrides: { maxExternalRounds: 2 },
      });
      state.pendingIntents = ["alpha"];

      await expect(phase.runRounds(ctx(controller.signal))).rejects.toThrow(
        WorkflowAbortedError,
      );
      // The abort must not be mistaken for a retryable discovery failure.
      expect(state.errors).toEqual([]);
    });

    it("throws before the first round when already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const { phase, state, discover } = build();
      state.pendingIntents = ["alpha"];

      await expect(phase.runRounds(ctx(controller.signal))).rejects.toThrow(
        WorkflowAbortedError,
      );
      expect(discover).not.toHaveBeenCalled();
    });
  });

  describe("runSingleRefinementRound", () => {
    it("resets sufficiency and runs exactly one round", async () => {
      const { phase, state, discover } = build();
      state.contextIsSufficient = true;
      state.pendingIntents = ["follow-up"];

      await phase.runSingleRefinementRound(ctx());

      expect(state.externalRounds).toBe(1);
      expect(discover).toHaveBeenCalledTimes(1);
    });

    it("uses the critic's intents as the round's topics", async () => {
      const { phase, state, discover } = build();
      state.pendingIntents = ["critic follow-up"];

      await phase.runSingleRefinementRound(ctx());

      expect(discover.mock.calls.map((call) => call[0])).toEqual([
        "critic follow-up",
      ]);
    });

    it("aborts before doing any work", async () => {
      const controller = new AbortController();
      controller.abort();
      const { phase } = build();

      await expect(
        phase.runSingleRefinementRound(ctx(controller.signal)),
      ).rejects.toThrow(WorkflowAbortedError);
    });
  });

  describe("adapter flexibility", () => {
    it("works without an isBlocked hook", async () => {
      const state = makeState({ maxExternalRounds: 1 });
      const discovery: ExternalDiscoveryAdapter<DiscoveredPayload, string> = {
        discover: async () => ({ targets: ["t1"] }),
        extractCandidates: (_intent, payload) => payload.targets,
      };
      const executeBatch = vi.fn(async () => true);
      const executor: TargetExecutorAdapter<string, string> = {
        getKey: (target) => target,
        executeBatch,
      };
      const phase = new ExternalDiscoveryPhase<
        string,
        DiscoveredPayload,
        string,
        string
      >(
        "w",
        discovery,
        executor,
        state,
        new EvaluatorPhase<string, string>(
          "w",
          "q",
          scriptedEvaluator([]).adapter,
          state,
          makeLogger(),
        ),
        makeLogger(),
      );
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(executeBatch).toHaveBeenCalledTimes(1);
    });

    it("uses a custom phase description for the evaluator prompt", async () => {
      const state = makeState({ maxExternalRounds: 1 });
      const discovery: ExternalDiscoveryAdapter<DiscoveredPayload, string> = {
        discover: async () => ({ targets: ["t1"] }),
        extractCandidates: (_intent, payload) => payload.targets,
      };
      const executor: TargetExecutorAdapter<string, string> = {
        getKey: (target) => target,
        executeBatch: vi.fn(async () => true),
      };
      const evaluator = scriptedEvaluator([
        { isSufficient: false, nextIntents: [] },
      ]);
      const phase = new ExternalDiscoveryPhase<
        string,
        DiscoveredPayload,
        string,
        string
      >(
        "w",
        discovery,
        executor,
        state,
        new EvaluatorPhase<string, string>(
          "w",
          "q",
          evaluator.adapter,
          state,
          makeLogger(),
        ),
        makeLogger(),
        "Custom phase wording",
      );
      state.pendingIntents = ["alpha"];

      await phase.runRounds(ctx());

      expect(evaluator.inputs[0].phaseDescription).toBe("Custom phase wording");
    });
  });
});

/**
 * The phase fingerprints through its evaluator, so seeding an "exhausted"
 * entry needs the same normalisation. Building a throwaway evaluator phase is
 * cheaper than exporting the fingerprint helper just for tests.
 */
function phaseFingerprint(
  state: ReturnType<typeof makeState<string, string>>,
  intent: string,
): string {
  return new EvaluatorPhase<string, string>(
    "w",
    "q",
    scriptedEvaluator([]).adapter,
    state,
    makeLogger(),
  ).fingerprint(intent);
}
