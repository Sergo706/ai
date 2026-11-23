import { describe, expect, it, vi } from "vitest";

import type { CriticVerdict } from "../types.js";
import { CriticPhase } from "../phases/CriticPhase.js";
import {
  ctx,
  makeLogger,
  makeState,
  testBudgets,
} from "~~/test/test-utils/agenticLoop.js";

/**
 * The critic is the last chance to notice a thin answer before synthesis. It
 * has exactly one expensive action — asking for another discovery round — so
 * the guards around that call are the whole of its behaviour.
 */

describe("CriticPhase", () => {
  function build(
    verdict: CriticVerdict,
    options: {
      withExternalPhase?: boolean;
      stateOverrides?: Partial<typeof testBudgets>;
    } = {},
  ) {
    const state = makeState(options.stateOverrides);
    const review = vi.fn(async () => verdict);
    const critic = { review };
    const runSingleRefinementRound = vi.fn(async () => {});
    const externalPhase =
      options.withExternalPhase === false ? null : { runSingleRefinementRound };
    const phase = new CriticPhase<string, string, string, string>(
      "w",
      critic,
      state,
      externalPhase as never,
      makeLogger(),
    );
    return { phase, state, review, runSingleRefinementRound };
  }

  it("does nothing when there is no evidence to review", async () => {
    const { phase, review } = build({ approved: true });

    await phase.run(ctx());

    // Nothing was collected, so there is nothing a critic could judge.
    expect(review).not.toHaveBeenCalled();
  });

  it("reviews once there is evidence", async () => {
    const { phase, state, review } = build({ approved: true });
    state.appendEvidence("a fact");

    await phase.run(ctx());

    expect(review).toHaveBeenCalledTimes(1);
  });

  it("hands the live state to the critic", async () => {
    const { phase, state, review } = build({ approved: true });
    state.appendEvidence("a fact");

    await phase.run(ctx());

    expect(review).toHaveBeenCalledWith(state, expect.anything());
  });

  describe("notes", () => {
    it("records the critic's notes", async () => {
      const { phase, state } = build({
        approved: true,
        notes: "thin on pricing",
      });
      state.appendEvidence("e");

      await phase.run(ctx());

      expect(state.criticNotes).toBe("thin on pricing");
    });

    it("leaves existing notes alone when the verdict has none", async () => {
      const { phase, state } = build({ approved: true });
      state.appendEvidence("e");
      state.criticNotes = "earlier note";

      await phase.run(ctx());

      expect(state.criticNotes).toBe("earlier note");
    });

    it("replaces an earlier note with a newer one", async () => {
      const { phase, state } = build({ approved: true, notes: "newer" });
      state.appendEvidence("e");
      state.criticNotes = "older";

      await phase.run(ctx());

      expect(state.criticNotes).toBe("newer");
    });
  });

  describe("refinement", () => {
    it("requests a refinement round when rejected with follow-ups", async () => {
      const { phase, state, runSingleRefinementRound } = build({
        approved: false,
        followUpIntents: ["pricing", "reviews"],
      });
      state.appendEvidence("e");

      await phase.run(ctx());

      expect(runSingleRefinementRound).toHaveBeenCalledTimes(1);
    });

    it("seeds the refinement round with the follow-up intents", async () => {
      const { phase, state } = build({
        approved: false,
        followUpIntents: ["pricing", "reviews"],
      });
      state.appendEvidence("e");

      await phase.run(ctx());

      expect(state.pendingIntents).toEqual(["pricing", "reviews"]);
    });

    it("caps the follow-up intents at the per-round budget", async () => {
      const { phase, state } = build(
        {
          approved: false,
          followUpIntents: ["a", "b", "c", "d"],
        },
        { stateOverrides: { maxIntentsPerRound: 2 } },
      );
      state.appendEvidence("e");

      await phase.run(ctx());

      expect(state.pendingIntents).toEqual(["a", "b"]);
    });

    it("does not refine when the verdict is approved", async () => {
      const { phase, state, runSingleRefinementRound } = build({
        approved: true,
        followUpIntents: ["ignored"],
      });
      state.appendEvidence("e");

      await phase.run(ctx());

      expect(runSingleRefinementRound).not.toHaveBeenCalled();
      expect(state.pendingIntents).toEqual(["the query"]);
    });

    it("does not refine when there are no follow-up intents", async () => {
      const { phase, state, runSingleRefinementRound } = build({
        approved: false,
      });
      state.appendEvidence("e");

      await phase.run(ctx());

      expect(runSingleRefinementRound).not.toHaveBeenCalled();
    });

    it("does not refine when there is no external phase", async () => {
      const { phase, state, runSingleRefinementRound } = build(
        { approved: false, followUpIntents: ["pricing"] },
        { withExternalPhase: false },
      );
      state.appendEvidence("e");

      await phase.run(ctx());

      expect(runSingleRefinementRound).not.toHaveBeenCalled();
    });

    it("still records notes when it cannot refine", async () => {
      const { phase, state } = build(
        { approved: false, notes: "weak", followUpIntents: ["pricing"] },
        { withExternalPhase: false },
      );
      state.appendEvidence("e");

      await phase.run(ctx());

      // The verdict is still useful even when the follow-up is dropped.
      expect(state.criticNotes).toBe("weak");
    });

    it("does not start a second round itself", async () => {
      const { phase, state, runSingleRefinementRound } = build({
        approved: false,
        followUpIntents: ["pricing"],
      });
      state.appendEvidence("e");

      await phase.run(ctx());

      // A single call is the contract; the external phase owns the one pass.
      expect(runSingleRefinementRound).toHaveBeenCalledTimes(1);
    });
  });

  it("propagates a critic failure to the caller", async () => {
    const state = makeState();
    state.appendEvidence("e");
    const critic = {
      review: vi.fn(async () => {
        throw new Error("critic down");
      }),
    };
    const phase = new CriticPhase<string, string, string, string>(
      "w",
      critic,
      state,
      null,
      makeLogger(),
    );

    await expect(phase.run(ctx())).rejects.toThrow("critic down");
  });
});
