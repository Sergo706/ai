import { describe, expect, it, vi } from "vitest";

import type {
  EvaluatorVerdict,
  LocalKnowledgeAdapter,
} from "../types.js";
import type { LocalItem } from "~~/test/test-utils/agenticLoop.js";
import { EvaluatorPhase } from "../phases/EvaluatorPhase.js";
import { LocalKnowledgePhase } from "../phases/LocalKnowledgePhase.js";
import { WorkflowAbortedError } from "../executionContext.js";
import {
  ctx,
  localAdapter,
  localItem,
  localPage,
  makeLogger,
  makeState,
  scriptedEvaluator,
  testBudgets,
} from "~~/test/test-utils/agenticLoop.js";

/**
 * The paging loop decides how much of the local index a run reads and when it
 * gives up. Every exit condition is a real budget decision: an empty page, a
 * short page, a repeated page, or a page the evaluator judged insufficient
 * several times in a row.
 */

describe("LocalKnowledgePhase", () => {
  function build(
    pages: LocalItem[][],
    verdicts: EvaluatorVerdict[],
    stateOverrides: Partial<typeof testBudgets> = {},
  ) {
    const state = makeState<LocalItem, LocalItem>(stateOverrides);
    const { adapter, calls } = localAdapter(pages);
    const evaluator = scriptedEvaluator(verdicts);
    const evaluatorPhase = new EvaluatorPhase<LocalItem, LocalItem>(
      "w",
      "q",
      evaluator.adapter,
      state,
      makeLogger(),
    );
    const phase = new LocalKnowledgePhase<LocalItem, LocalItem>(
      "w",
      adapter,
      state,
      evaluatorPhase,
      makeLogger(),
    );
    return { phase, state, calls, evaluator };
  }

  describe("paging", () => {
    it("walks pages until a short page ends the search", async () => {
      const { phase, state, calls } = build(
        [localPage("1", "2", "3"), localPage("4")],
        [{ isSufficient: false, nextIntents: ["x"] }],
      );

      await phase.run(ctx());

      expect(calls).toEqual([
        { offset: 0, limit: 3 },
        { offset: 3, limit: 3 },
      ]);
      expect(state.localItems.map((item) => item.id)).toEqual([
        "1",
        "2",
        "3",
        "4",
      ]);
      expect(state.localSearches).toBe(2);
    });

    it("stops on the first empty page", async () => {
      const { phase, calls } = build(
        [[]],
        [{ isSufficient: false, nextIntents: ["x"] }],
      );

      await phase.run(ctx());

      expect(calls).toHaveLength(1);
    });

    it("never exceeds maxLocalRounds", async () => {
      const full = localPage("1", "2", "3");
      const { phase, calls } = build(
        [full, full, full, full, full, full],
        [{ isSufficient: false, nextIntents: ["x"] }],
        { maxLocalRounds: 3 },
      );

      await phase.run(ctx());

      expect(calls).toHaveLength(3);
    });

    it("keeps paging through repeated full pages up to the round budget", async () => {
      const full = localPage("1", "2", "3");
      const { phase, calls } = build(
        [full, full, full, full, full],
        [{ isSufficient: false, nextIntents: ["x"] }],
        { maxLocalRounds: 5, maxConsecutiveInsufficientLocalBatches: 2 },
      );

      await phase.run(ctx());

      // Every page repeats the same ids, so only the first adds evidence and
      // the rest reset the streak instead of growing it.
      expect(calls).toHaveLength(5);
    });

    it("honours a resume offset", async () => {
      const { phase, calls } = build(
        [localPage("1"), localPage("2"), localPage("3")],
        [{ isSufficient: false, nextIntents: ["x"] }],
      );

      await phase.run(ctx(), { startBatch: 1 });

      expect(calls[0]).toEqual({ offset: 3, limit: 3 });
    });

    it("does not fetch before the resume offset", async () => {
      const { phase, calls } = build(
        [localPage("1", "2", "3"), localPage("4", "5", "6"), localPage("7")],
        [{ isSufficient: false, nextIntents: ["x"] }],
        { maxLocalRounds: 5 },
      );

      await phase.run(ctx(), { startBatch: 2 });

      expect(calls.map((call) => call.offset)).toEqual([6]);
    });

    it("counts each fetched batch as one local search", async () => {
      const { phase, state } = build(
        [localPage("1", "2", "3"), localPage("4")],
        [{ isSufficient: false, nextIntents: ["x"] }],
      );

      await phase.run(ctx());

      expect(state.localSearches).toBe(2);
    });
  });

  describe("evidence", () => {
    it("appends the formatted evidence for every new item", async () => {
      const { phase, state } = build(
        [localPage("1", "2")],
        [{ isSufficient: false, nextIntents: ["x"] }],
      );

      await phase.run(ctx());

      expect(state.evidenceSet).toEqual(["[1] text 1", "[2] text 2"]);
    });

    it("de-duplicates an item seen in an earlier page", async () => {
      const { phase, state } = build(
        [localPage("1", "2"), localPage("2", "3")],
        [{ isSufficient: false, nextIntents: ["x"] }],
        { localBatchSize: 2 },
      );

      await phase.run(ctx());

      expect(state.localItems.map((item) => item.id)).toEqual(["1", "2", "3"]);
      expect(state.evidenceSet).toHaveLength(3);
    });

    it("skips an item whose evidence formats to null", async () => {
      const { phase, state } = build(
        [[localItem("1", "")]],
        [{ isSufficient: false, nextIntents: ["x"] }],
      );

      await phase.run(ctx());

      expect(state.evidenceSet).toEqual([]);
      expect(state.localItems).toEqual([]);
    });

    it("skips an item whose evidence formats to whitespace", async () => {
      const state = makeState<LocalItem, LocalItem>();
      const adapter: LocalKnowledgeAdapter<LocalItem> = {
        fetchBatch: vi.fn(async () => [localItem("1", "   ")]),
        getId: (item) => item.id,
        // Formats to whitespace, which is neither null nor an empty string.
        formatEvidence: () => "   ",
      };
      const evaluatorPhase = new EvaluatorPhase<LocalItem, LocalItem>(
        "w",
        "q",
        scriptedEvaluator([{ isSufficient: false, nextIntents: [] }]).adapter,
        state,
        makeLogger(),
      );
      const phase = new LocalKnowledgePhase<LocalItem, LocalItem>(
        "w",
        adapter,
        state,
        evaluatorPhase,
        makeLogger(),
      );

      await phase.run(ctx());

      // Regression: the raw block used to be appended after only being tested
      // for emptiness, so a whitespace block still occupied an evidence slot.
      expect(state.evidenceSet).toEqual([]);
      expect(state.localItems).toEqual([]);
    });

    it("records an item as seen even when its evidence is unusable", async () => {
      const { phase, state } = build(
        [[localItem("1", "")]],
        [{ isSufficient: false, nextIntents: ["x"] }],
      );

      await phase.run(ctx());

      // So a later page cannot resurrect it as new evidence.
      expect(state.seenLocalIds.has("1")).toBe(true);
    });

    it("does not consult the evaluator when a page adds no evidence", async () => {
      const { phase, evaluator } = build(
        [[localItem("1", "")]],
        [{ isSufficient: true, nextIntents: [] }],
      );

      await phase.run(ctx());

      expect(evaluator.calls).toBe(0);
    });
  });

  describe("stop conditions", () => {
    it("breaks as soon as the evaluator reports sufficient", async () => {
      const { phase, state, calls } = build(
        [localPage("1", "2", "3"), localPage("4")],
        [{ isSufficient: true, nextIntents: [] }],
      );

      await phase.run(ctx());

      expect(calls).toHaveLength(1);
      expect(state.contextIsSufficient).toBe(true);
    });

    it("stops at the consecutive insufficient limit when every page is new", async () => {
      const { phase, calls } = build(
        [
          localPage("1", "2", "3"),
          localPage("4", "5", "6"),
          localPage("7", "8", "9"),
          localPage("a", "b", "c"),
        ],
        [{ isSufficient: false, nextIntents: ["x"] }],
        { maxConsecutiveInsufficientLocalBatches: 2 },
      );

      await phase.run(ctx());

      expect(calls).toHaveLength(2);
    });

    it("resets the insufficient streak after a page that adds nothing", async () => {
      const { phase, calls } = build(
        [
          localPage("1", "2", "3"),
          // A full-length page whose items all format to nothing, so it is
          // neither a short batch nor a page that grows the evidence set.
          [localItem("x", ""), localItem("y", ""), localItem("z", "")],
          localPage("4", "5", "6"),
          localPage("7"),
        ],
        [{ isSufficient: false, nextIntents: ["x"] }],
        { maxConsecutiveInsufficientLocalBatches: 2 },
      );

      await phase.run(ctx());

      // Batch #0 insufficient (streak 1), #1 adds nothing (reset), #2
      // insufficient (streak 1), then #3 is short and ends the run. Without the
      // reset the loop would have been cut off after batch #1.
      expect(calls).toHaveLength(4);
    });

    it("stops at the limit without ever reaching a short page", async () => {
      const { phase, state, calls } = build(
        [
          localPage("1", "2", "3"),
          localPage("4", "5", "6"),
          localPage("7", "8", "9"),
        ],
        [{ isSufficient: false, nextIntents: ["x"] }],
        { maxConsecutiveInsufficientLocalBatches: 2 },
      );

      await phase.run(ctx());

      expect(calls).toHaveLength(2);
      expect(state.contextIsSufficient).toBe(false);
    });
  });

  describe("checkpointing", () => {
    it("fires onBatchComplete once per batch with the batch index", async () => {
      const { phase } = build(
        [localPage("1", "2", "3"), localPage("4")],
        [{ isSufficient: false, nextIntents: ["x"] }],
      );
      const onBatchComplete = vi.fn();

      await phase.run(ctx(), { onBatchComplete });

      expect(onBatchComplete.mock.calls).toEqual([[0], [1]]);
    });

    it("fires onBatchComplete before the batch is fetched", async () => {
      const onBatchComplete = vi.fn();
      const state = makeState<LocalItem, LocalItem>();
      let fetchedAfterCallback = false;
      const adapter: LocalKnowledgeAdapter<LocalItem> = {
        fetchBatch: vi.fn(() => {
          fetchedAfterCallback = onBatchComplete.mock.calls.length > 0;
          return Promise.resolve([]);
        }),
        getId: (item) => item.id,
        formatEvidence: (item) => item.text,
      };
      const evaluatorPhase = new EvaluatorPhase<LocalItem, LocalItem>(
        "w",
        "q",
        scriptedEvaluator([]).adapter,
        state,
        makeLogger(),
      );
      const phase = new LocalKnowledgePhase<LocalItem, LocalItem>(
        "w",
        adapter,
        state,
        evaluatorPhase,
        makeLogger(),
      );

      await phase.run(ctx(), { onBatchComplete });

      expect(fetchedAfterCallback).toBe(true);
    });

    it("does not require a checkpoint callback", async () => {
      const { phase } = build(
        [localPage("1")],
        [{ isSufficient: false, nextIntents: ["x"] }],
      );

      await expect(phase.run(ctx())).resolves.toBeUndefined();
    });
  });

  describe("abort", () => {
    it("throws before the first fetch when already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const { phase, calls } = build([localPage("1")], []);

      await expect(phase.run(ctx(controller.signal))).rejects.toThrow(
        WorkflowAbortedError,
      );
      expect(calls).toHaveLength(0);
    });

    it("aborts mid-phase without fetching the next batch", async () => {
      const controller = new AbortController();
      const state = makeState<LocalItem, LocalItem>();
      const fetchBatch = vi.fn(
        (_offset: number, _limit: number): Promise<LocalItem[]> => {
          controller.abort();
          return Promise.resolve(localPage("1", "2", "3"));
        },
      );
      const adapter: LocalKnowledgeAdapter<LocalItem> = {
        fetchBatch,
        getId: (item) => item.id,
        formatEvidence: (item) => item.text,
      };
      const evaluatorPhase = new EvaluatorPhase<LocalItem, LocalItem>(
        "w",
        "q",
        scriptedEvaluator([]).adapter,
        state,
        makeLogger(),
      );
      const phase = new LocalKnowledgePhase<LocalItem, LocalItem>(
        "w",
        adapter,
        state,
        evaluatorPhase,
        makeLogger(),
      );

      await expect(phase.run(ctx(controller.signal))).rejects.toThrow(
        WorkflowAbortedError,
      );
      expect(fetchBatch).toHaveBeenCalledTimes(1);
    });

    it("does not fire the checkpoint for a batch that was aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const { phase } = build([localPage("1")], []);
      const onBatchComplete = vi.fn();

      await expect(
        phase.run(ctx(controller.signal), { onBatchComplete }),
      ).rejects.toThrow(WorkflowAbortedError);
      expect(onBatchComplete).not.toHaveBeenCalled();
    });
  });

  describe("adapter flexibility", () => {
    it("tolerates an adapter with no getScore", async () => {
      const state = makeState<LocalItem, LocalItem>();
      const adapter: LocalKnowledgeAdapter<LocalItem> = {
        fetchBatch: vi.fn(async () => [localItem("1", "hello")]),
        getId: (item) => item.id,
        formatEvidence: (item) => item.text,
      };
      const evaluatorPhase = new EvaluatorPhase<LocalItem, LocalItem>(
        "w",
        "q",
        scriptedEvaluator([]).adapter,
        state,
        makeLogger(),
      );
      const phase = new LocalKnowledgePhase<LocalItem, LocalItem>(
        "w",
        adapter,
        state,
        evaluatorPhase,
        makeLogger(),
      );

      await expect(phase.run(ctx())).resolves.toBeUndefined();
      expect(state.evidenceSet).toEqual(["hello"]);
    });

    it("mixes string and numeric ids in the dedupe set", async () => {
      const state = makeState<LocalItem, LocalItem>();
      const items: LocalItem[] = [localItem("1"), localItem("2")];
      const adapter: LocalKnowledgeAdapter<LocalItem> = {
        fetchBatch: vi.fn(async () => items),
        getId: (item) => (item.id === "1" ? "1" : Number(item.id)),
        formatEvidence: (item) => item.text,
      };
      const evaluatorPhase = new EvaluatorPhase<LocalItem, LocalItem>(
        "w",
        "q",
        scriptedEvaluator([]).adapter,
        state,
        makeLogger(),
      );
      const phase = new LocalKnowledgePhase<LocalItem, LocalItem>(
        "w",
        adapter,
        state,
        evaluatorPhase,
        makeLogger(),
      );

      await phase.run(ctx());

      expect(state.seenLocalIds.has("1")).toBe(true);
      expect(state.seenLocalIds.has(2)).toBe(true);
    });
  });
});
