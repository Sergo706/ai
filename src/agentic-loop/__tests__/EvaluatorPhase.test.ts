import { describe, expect, it, vi } from "vitest";

import type { EvaluatorAdapter, EvaluatorVerdict } from "../types.js";
import { EvaluatorPhase } from "../phases/EvaluatorPhase.js";
import { WorkflowAbortedError } from "../executionContext.js";
import {
  ctx,
  makeLogger,
  makeState,
  scriptedEvaluator,
  testBudgets,
} from "~~/test/test-utils/agenticLoop.js";

/**
 * The evaluator is the only thing that decides whether a run continues. Its
 * verdict handling, intent bookkeeping and repeat accounting decide whether a
 * research run burns its budget re-searching the same terms or stops early with
 * a thin answer.
 *
 * The adapter is a plain scripted object, so the real normalisation, fallback
 * and accounting code runs unmodified.
 */

describe("EvaluatorPhase", () => {
  function build(
    verdicts: EvaluatorVerdict[],
    stateOverrides: Partial<typeof testBudgets> = {},
    options: Parameters<typeof scriptedEvaluator>[1] = {},
  ) {
    const state = makeState(stateOverrides);
    const evaluator = scriptedEvaluator(verdicts, options);
    const phase = new EvaluatorPhase<string, string>(
      "w",
      "the query",
      evaluator.adapter,
      state,
      makeLogger(),
    );
    return { phase, state, evaluator };
  }

  describe("verdict handling", () => {
    it("reports the placeholder evidence text when nothing was collected", async () => {
      const { phase, evaluator } = build([
        { isSufficient: false, nextIntents: ["a"] },
      ]);

      await expect(phase.evaluate("phase", ctx())).resolves.toBe(false);
      expect(evaluator.inputs[0].evidenceText).toBe(
        "No usable evidence was found.",
      );
      expect(evaluator.inputs[0].coldStart).toBe(false);
    });

    it("passes the cold-start flag through to the adapter", async () => {
      const { phase, evaluator } = build([
        { isSufficient: false, nextIntents: ["a"] },
      ]);

      await phase.evaluate("phase", ctx(), true);

      expect(evaluator.inputs[0].coldStart).toBe(true);
    });

    it("passes the phase description through verbatim", async () => {
      const { phase, evaluator } = build([
        { isSufficient: false, nextIntents: ["a"] },
      ]);

      await phase.evaluate("Search results were just retrieved", ctx());

      expect(evaluator.inputs[0].phaseDescription).toBe(
        "Search results were just retrieved",
      );
    });

    it("ignores a sufficient verdict while there is no evidence", async () => {
      const { phase } = build([{ isSufficient: true, nextIntents: [] }]);

      // A "sufficient" verdict with nothing behind it cannot be trusted.
      await expect(phase.evaluate("phase", ctx())).resolves.toBe(false);
    });

    it("returns true once evidence exists and the verdict is sufficient", async () => {
      const { phase, state } = build([{ isSufficient: true, nextIntents: [] }]);
      state.appendEvidence("a fact");

      await expect(phase.evaluate("phase", ctx())).resolves.toBe(true);
    });

    it("does not write contextIsSufficient itself, the caller owns it", async () => {
      const { phase, state } = build([{ isSufficient: true, nextIntents: [] }]);
      state.appendEvidence("a fact");

      await phase.evaluate("phase", ctx());

      // Still false: the phase reports, the loop assigns.
      expect(state.contextIsSufficient).toBe(false);
    });

    it("clears the pending intents when the answer is sufficient", async () => {
      const { phase, state } = build([
        { isSufficient: true, nextIntents: ["more"] },
      ]);
      state.appendEvidence("a fact");

      await phase.evaluate("phase", ctx());

      expect(state.pendingIntents).toEqual([]);
    });

    it("joins the evidence blocks with a separator for the prompt", async () => {
      const { phase, state, evaluator } = build([
        { isSufficient: false, nextIntents: ["gamma"] },
      ]);
      state.appendEvidence("first");
      state.appendEvidence("second");

      await phase.evaluate("phase", ctx());

      expect(evaluator.inputs[0].evidenceText).toBe("first\n\n---\n\nsecond");
    });

    it("sends the union of issued and exhausted intents to the adapter", async () => {
      const { phase, state, evaluator } = build([
        { isSufficient: false, nextIntents: ["gamma"] },
      ]);
      state.issuedIntents.set("a", "alpha");
      state.exhaustedIntents.set("b", "beta");

      await phase.evaluate("phase", ctx());

      expect(evaluator.inputs[0].issuedOrExhaustedIntents.sort()).toEqual([
        "alpha",
        "beta",
      ]);
      expect(evaluator.inputs[0].exhaustedIntents).toEqual(["beta"]);
    });

    it("surfaces only the current round's failures to the adapter", async () => {
      const { phase, state, evaluator } = build([
        { isSufficient: false, nextIntents: ["gamma"] },
      ]);
      state.failedIntents.push("broken");

      await phase.evaluate("phase", ctx());

      expect(evaluator.inputs[0].failedIntents).toEqual(["broken"]);
    });
  });

  describe("next-intent normalisation", () => {
    it("trims, de-duplicates and caps the next intents", async () => {
      const { phase, state } = build(
        [
          {
            isSufficient: false,
            nextIntents: ["  one  ", "one", "two", "", "three", "four"],
          },
        ],
        { maxIntentsPerRound: 3 },
      );

      await phase.evaluate("phase", ctx());

      expect(state.pendingIntents).toEqual(["one", "two", "three"]);
    });

    it("applies transformIntent to every next intent", async () => {
      const { phase, state } = build(
        [{ isSufficient: false, nextIntents: ["alpha", "beta"] }],
        {},
        { transformIntent: (intent) => `site:shop.com ${intent}` },
      );

      await phase.evaluate("phase", ctx());

      expect(state.pendingIntents).toEqual([
        "site:shop.com alpha",
        "site:shop.com beta",
      ]);
    });

    it("trims before transforming, so the transform sees clean input", async () => {
      const { phase, state } = build(
        [{ isSufficient: false, nextIntents: ["  spaced  "] }],
        {},
        { transformIntent: (intent) => `  ${intent} extra  ` },
      );

      await phase.evaluate("phase", ctx());

      // The transform runs on the trimmed intent and its own padding is left
      // alone, so a transform cannot reintroduce whitespace the dedupe missed.
      expect(state.pendingIntents).toEqual(["  spaced extra  "]);
    });

    it("falls back to the original query when no usable intents come back", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: ["   "] },
      ]);

      await phase.evaluate("phase", ctx());

      expect(state.pendingIntents).toEqual(["the query"]);
    });

    it("falls back to the query when the evaluator returns nothing at all", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: [] },
      ]);

      await phase.evaluate("phase", ctx());

      expect(state.pendingIntents).toEqual(["the query"]);
    });

    it("does not fall back when the verdict is sufficient and backed by evidence", async () => {
      const { phase, state } = build([{ isSufficient: true, nextIntents: [] }]);
      state.appendEvidence("fact");

      await phase.evaluate("phase", ctx());

      expect(state.pendingIntents).toEqual([]);
    });
  });

  describe("intent bookkeeping", () => {
    it("records fresh intents as issued", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: ["alpha"] },
      ]);

      await phase.evaluate("phase", ctx());

      expect([...state.issuedIntents.values()]).toEqual(["alpha"]);
    });

    it("keeps the original wording when marking an intent exhausted", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: ["alpha shoes"] },
      ]);
      const fingerprint = phase.fingerprint("alpha shoes");
      state.issuedIntents.set(fingerprint, "alpha shoes");
      state.dispatchedIntents.add(fingerprint);

      await phase.evaluate("phase", ctx());

      expect(state.exhaustedIntents.get(fingerprint)).toBe("alpha shoes");
    });

    it("treats an already-exhausted intent as a repeat without re-issuing it", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: ["alpha"] },
      ]);
      state.exhaustedIntents.set(phase.fingerprint("alpha"), "alpha");

      await phase.evaluate("phase", ctx());

      expect(state.issuedIntents.size).toBe(0);
      expect(state.lastEvaluationRepeatCount).toBe(1);
    });

    it("does not mark an intent as issued twice", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: ["alpha"] },
        { isSufficient: false, nextIntents: ["alpha"] },
      ]);

      await phase.evaluate("phase", ctx());
      const issuedAfterFirst = state.issuedIntents.size;
      await phase.evaluate("phase", ctx());

      expect(issuedAfterFirst).toBe(1);
      expect(state.issuedIntents.size).toBe(1);
    });

    it("does not count an issued-only intent as a repeat", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: ["alpha"] },
      ]);
      // Prepared but never dispatched, so it has not been searched yet.
      state.issuedIntents.set(phase.fingerprint("alpha"), "alpha");

      await phase.evaluate("phase", ctx());

      expect(state.exhaustedIntents.size).toBe(0);
      expect(state.lastEvaluationRepeatCount).toBe(0);
    });

    it("leaves unrelated intents untouched", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: ["alpha"] },
      ]);
      state.issuedIntents.set("x", "unrelated");

      await phase.evaluate("phase", ctx());

      expect(state.issuedIntents.get("x")).toBe("unrelated");
      expect(state.lastEvaluationRepeatCount).toBe(0);
    });
  });

  describe("repeat accounting", () => {
    it("marks a fully repeated round and starts the streak", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: ["alpha"] },
      ]);
      const fingerprint = phase.fingerprint("alpha");
      state.issuedIntents.set(fingerprint, "alpha");
      state.dispatchedIntents.add(fingerprint);

      await phase.evaluate("phase", ctx());

      expect([...state.exhaustedIntents.values()]).toEqual(["alpha"]);
      expect(state.lastEvaluationRepeatCount).toBe(1);
      expect(state.lastEvaluationAllRepeated).toBe(true);
      expect(state.consecutiveRepeatedIntentRounds).toBe(1);
    });

    it("lets consecutive repeat rounds accumulate", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: ["alpha"] },
        { isSufficient: false, nextIntents: ["alpha"] },
      ]);
      const fingerprint = phase.fingerprint("alpha");
      state.issuedIntents.set(fingerprint, "alpha");
      state.dispatchedIntents.add(fingerprint);

      await phase.evaluate("phase", ctx());
      await phase.evaluate("phase", ctx());

      expect(state.consecutiveRepeatedIntentRounds).toBe(2);
    });

    it("resets the streak when a fresh intent appears", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: ["alpha"] },
        { isSufficient: false, nextIntents: ["beta"] },
      ]);
      const fingerprint = phase.fingerprint("alpha");
      state.issuedIntents.set(fingerprint, "alpha");
      state.dispatchedIntents.add(fingerprint);

      await phase.evaluate("phase", ctx());
      expect(state.consecutiveRepeatedIntentRounds).toBe(1);

      await phase.evaluate("phase", ctx());
      expect(state.consecutiveRepeatedIntentRounds).toBe(0);
      expect(state.lastEvaluationAllRepeated).toBe(false);
    });

    it("does not call a mixed batch all-repeated", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: ["alpha", "beta"] },
      ]);
      const fingerprint = phase.fingerprint("alpha");
      state.issuedIntents.set(fingerprint, "alpha");
      state.dispatchedIntents.add(fingerprint);

      await phase.evaluate("phase", ctx());

      expect(state.lastEvaluationRepeatCount).toBe(1);
      expect(state.lastEvaluationAllRepeated).toBe(false);
      expect(state.consecutiveRepeatedIntentRounds).toBe(0);
    });

    it("clears the per-round flags once sufficient", async () => {
      const { phase, state } = build([{ isSufficient: true, nextIntents: [] }]);
      state.lastEvaluationAllRepeated = true;
      state.lastEvaluationRepeatCount = 2;
      state.appendEvidence("fact");

      await phase.evaluate("phase", ctx());

      // Only the two "this round" fields are reset. The consecutive counter is
      // deliberately left alone so a later insufficient round does not inherit
      // a clean streak.
      expect(state.lastEvaluationAllRepeated).toBe(false);
      expect(state.lastEvaluationRepeatCount).toBe(0);
    });
  });

  describe("fingerprinting", () => {
    it("uses the adapter fingerprint when one is supplied", () => {
      const state = makeState();
      const adapter: EvaluatorAdapter = {
        evaluate: vi.fn(),
        fingerprint: (intent) => intent.toUpperCase(),
      };
      const phase = new EvaluatorPhase<string, string>(
        "w",
        "q",
        adapter,
        state,
        makeLogger(),
      );

      expect(phase.fingerprint("abc")).toBe("ABC");
    });

    it("normalises case and whitespace with the default fingerprint", () => {
      const { phase } = build([]);

      expect(phase.fingerprint("Running Shoes")).toBe(
        phase.fingerprint("  running   shoes "),
      );
    });

    it("treats rephrased intents as the same intent", async () => {
      const { phase, state } = build([
        { isSufficient: false, nextIntents: ["running shoes"] },
        { isSufficient: false, nextIntents: ["Running  Shoes"] },
      ]);
      state.dispatchedIntents.add(phase.fingerprint("running shoes"));

      await phase.evaluate("phase", ctx());
      await phase.evaluate("phase", ctx());

      // Both rounds asked for the same thing, so the second is a repeat.
      expect(state.lastEvaluationAllRepeated).toBe(true);
    });
  });

  describe("failure handling", () => {
    it("swallows an adapter failure into state.errors and returns false", async () => {
      const state = makeState();
      const adapter: EvaluatorAdapter = {
        evaluate: vi.fn(async () => {
          throw new Error("model exploded");
        }),
      };
      const phase = new EvaluatorPhase<string, string>(
        "w",
        "q",
        adapter,
        state,
        makeLogger(),
      );

      await expect(phase.evaluate("phase", ctx())).resolves.toBe(false);
      expect(state.errors).toEqual(["Evaluator failed: model exploded"]);
    });

    it("stringifies a non-Error rejection", async () => {
      const state = makeState();
      const adapter: EvaluatorAdapter = {
        evaluate: vi.fn(() =>
          // Third-party adapters can reject with a non-Error value; the phase
          // has to stringify it rather than read `.message` off it.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          Promise.reject({ code: "E_MODEL" }),
        ),
      };
      const phase = new EvaluatorPhase<string, string>(
        "w",
        "q",
        adapter,
        state,
        makeLogger(),
      );

      await phase.evaluate("phase", ctx());

      expect(state.errors).toEqual(["Evaluator failed: [object Object]"]);
    });

    it("leaves the pending intents alone after a failure", async () => {
      const state = makeState();
      const adapter: EvaluatorAdapter = {
        evaluate: vi.fn(async () => {
          throw new Error("boom");
        }),
      };
      const phase = new EvaluatorPhase<string, string>(
        "w",
        "q",
        adapter,
        state,
        makeLogger(),
      );

      await phase.evaluate("phase", ctx());

      expect(state.pendingIntents).toEqual(["the query"]);
      expect(state.contextIsSufficient).toBe(false);
    });

    it("re-throws an abort instead of treating it as a soft failure", async () => {
      const controller = new AbortController();
      controller.abort();
      const state = makeState();
      const adapter: EvaluatorAdapter = {
        evaluate: vi.fn(async () => {
          throw new Error("aborted");
        }),
      };
      const phase = new EvaluatorPhase<string, string>(
        "w",
        "q",
        adapter,
        state,
        makeLogger(),
      );

      await expect(
        phase.evaluate("phase", ctx(controller.signal)),
      ).rejects.toThrow(WorkflowAbortedError);
      // The abort must not be recorded as a normal evaluation failure.
      expect(state.errors).toEqual([]);
    });
  });
});
