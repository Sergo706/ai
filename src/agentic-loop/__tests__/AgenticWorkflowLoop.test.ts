import { describe, expect, it, vi } from "vitest";

import { AgenticWorkflowLoop } from "../AgenticWorkflowLoop.js";
import type {
  AgenticWorkflowConfig,
  WorkflowCheckpoint,
  WorkflowProgressEvent,
} from "../types.js";
import {
  type DiscoveredPayload,
  type LocalItem,
  discoveryHarness,
  localAdapter,
  localPage,
  makeSpyLogger,
  scriptedEvaluator,
  testBudgets,
} from "~~/test/test-utils/agenticLoop.js";

/**
 * `AgenticWorkflowLoop` is the wiring, so these tests are about the wiring:
 * which stages run, in what order, when one is skipped, and that a caller who
 * disconnects gets a result instead of an exception. Every adapter behind it is
 * a real adapter object driven by the real phase classes — nothing about the
 * phases' own logic is re-mocked here.
 */

type Config = AgenticWorkflowConfig<
  LocalItem,
  DiscoveredPayload,
  string,
  string,
  string
>;

function parts() {
  const local = localAdapter([localPage("1"), localPage("2"), localPage("3")]);
  // Each discovery call has to yield a *new* target, otherwise the external
  // phase correctly concludes that no new sources are available and stops
  // after one round, which is a different thing to test.
  let discovered = 0;
  const discovery = discoveryHarness({
    discover: async () => {
      discovered++;
      return { targets: [`t${String(discovered)}`] };
    },
  });
  const evaluator = scriptedEvaluator([
    { isSufficient: false, nextIntents: [] },
  ]);
  const review = vi.fn(async () => ({ approved: true }));
  const synthesize = vi.fn(async () => "the report");

  return { local, discovery, evaluator, review, synthesize };
}

function config(
  made: ReturnType<typeof parts>,
  overrides: Partial<Config> = {},
): Config {
  return {
    name: "w",
    query: "a query",
    budgets: testBudgets,
    localKnowledge: made.local.adapter,
    externalDiscovery: made.discovery.discovery,
    targetExecutor: made.discovery.executor,
    evaluator: made.evaluator.adapter,
    critic: { review: made.review },
    finalAnswer: { synthesize: made.synthesize },
    ...overrides,
  };
}

function run(configuration: Config) {
  return new AgenticWorkflowLoop<
    LocalItem,
    DiscoveredPayload,
    string,
    string,
    string
  >(configuration).run();
}

describe("AgenticWorkflowLoop — construction", () => {
  it("refuses an empty query", () => {
    const made = parts();

    expect(() => run(config(made, { query: "" }))).toThrow(
      "w query cannot be empty",
    );
  });

  it("refuses a whitespace-only query", () => {
    const made = parts();

    expect(() => run(config(made, { query: "   \t " }))).toThrow(
      /cannot be empty/,
    );
  });
});

describe("AgenticWorkflowLoop — stage order", () => {
  it("runs seeds, local, external, critic then final", async () => {
    const order: string[] = [];
    const local = localAdapter([localPage("1")]);
    const discovery = discoveryHarness({
      discover: async () => {
        order.push("discover");
        return { targets: ["t1"] };
      },
      executeBatch: async (targets, state) => {
        // Seed execution and round execution share one executor, so label them
        // by what the run has already done.
        order.push(targets.includes("seed") ? "seed" : "execute");
        for (const target of targets) state.appendEvidence(`ev ${target}`);
        return targets.length > 0;
      },
    });
    const evaluator = scriptedEvaluator([
      { isSufficient: false, nextIntents: [] },
    ]);
    const review = vi.fn(async () => {
      order.push("critic");
      return { approved: true };
    });
    const synthesize = vi.fn(async () => {
      order.push("final");
      return "the report";
    });

    await run(
      config(
        {
          local: {
            ...local,
            adapter: {
              ...local.adapter,
              fetchBatch: vi.fn(
                async (
                  offset: number,
                  limit: number,
                  state: never,
                  context: never,
                ) => {
                  order.push("local");
                  return await local.adapter.fetchBatch(
                    offset,
                    limit,
                    state,
                    context,
                  );
                },
              ),
            },
          },
          discovery,
          evaluator,
          review,
          synthesize,
        },
        {
          seedTargets: ["seed"],
          budgets: { ...testBudgets, maxExternalRounds: 1 },
        },
      ),
    );

    expect(order).toEqual([
      "seed",
      "local",
      "discover",
      "execute",
      "critic",
      "final",
    ]);
  });
});

describe("AgenticWorkflowLoop — seed stage", () => {
  it("executes the supplied seed targets", async () => {
    const made = parts();

    await run(config(made, { seedTargets: ["a", "b"] }));

    expect(made.discovery.executeBatch.mock.calls[0]?.[0]).toEqual(["a", "b"]);
  });

  it("skips the seed stage when no seeds are supplied", async () => {
    const made = parts();

    await run(config(made));

    const batches = made.discovery.executeBatch.mock.calls.map(
      (call) => call[0],
    );
    expect(batches).not.toContainEqual(["a", "b"]);
  });

  it("finalizes early when the seeds already satisfy the evaluator", async () => {
    const made = parts();
    const evaluator = scriptedEvaluator([
      { isSufficient: true, nextIntents: [] },
    ]);

    const result = await run(
      config(made, {
        seedTargets: ["a"],
        evaluator: evaluator.adapter,
      }),
    );

    expect(result.isSufficient).toBe(true);
    expect(result.stopReason).toBe("sufficient");
    expect(made.local.calls).toEqual([]);
    expect(made.review).not.toHaveBeenCalled();
  });
});

describe("AgenticWorkflowLoop — local stage", () => {
  it("finalizes early when local knowledge satisfies the evaluator", async () => {
    const made = parts();
    const evaluator = scriptedEvaluator([
      { isSufficient: true, nextIntents: [] },
    ]);

    const result = await run(config(made, { evaluator: evaluator.adapter }));

    expect(result.isSufficient).toBe(true);
    expect(result.source).toBe("local");
    expect(made.discovery.discover).not.toHaveBeenCalled();
  });

  it("skips local knowledge when configured to", async () => {
    const made = parts();

    await run(config(made, { skipLocal: true }));

    expect(made.local.calls).toEqual([]);
  });

  it("skips local knowledge when no adapter is supplied", async () => {
    const made = parts();

    await run(config(made, { localKnowledge: undefined }));

    expect(made.local.calls).toEqual([]);
  });

  it("starts from the batch the checkpoint recorded", async () => {
    const made = parts();

    await run(
      config(made, {
        resumeFrom: {
          completedStages: [],
          localSearches: 2,
          externalRounds: 0,
          state: {},
        },
      }),
    );

    // Batch 2 means the first two pages were already read.
    expect(made.local.calls.at(0)).toEqual({
      offset: 2 * testBudgets.localBatchSize,
      limit: testBudgets.localBatchSize,
    });
  });
});

describe("AgenticWorkflowLoop — external stage", () => {
  /**
   * A fresh intent on every call, so the external phase keeps going instead of
   * stopping at "every outstanding intent was already searched". Without this a
   * run does exactly one round whatever the budget says.
   */
  function endlessEvaluator() {
    let call = 0;
    return {
      evaluate: async () => {
        call++;
        return { isSufficient: false, nextIntents: [`intent ${String(call)}`] };
      },
    };
  }

  it("does not re-spend the rounds a resume already recorded", async () => {
    const resumed = parts();
    const fresh = parts();

    await run(
      config(resumed, {
        evaluator: endlessEvaluator(),
        resumeFrom: {
          completedStages: [],
          localSearches: 1,
          externalRounds: 1,
          state: {},
        },
      }),
    );

    await run(config(fresh, { evaluator: endlessEvaluator() }));

    // One round was already spent, so a resumed run gets exactly one fewer
    // discovery round than a fresh run with the same budget.
    expect(fresh.discovery.discover.mock.calls.length).toBe(
      testBudgets.maxExternalRounds,
    );
    expect(resumed.discovery.discover.mock.calls.length).toBe(
      testBudgets.maxExternalRounds - 1,
    );
  });

  it("runs the cold-start evaluator when nothing was found locally", async () => {
    const made = parts();
    const evaluator = scriptedEvaluator([
      { isSufficient: false, nextIntents: [] },
    ]);

    await run(
      config(made, {
        localKnowledge: undefined,
        evaluator: evaluator.adapter,
      }),
    );

    expect(evaluator.inputs[0]?.coldStart).toBe(true);
    expect(evaluator.inputs[0]?.phaseDescription).toMatch(/No evidence/);
  });

  it("falls back to the query when the cold-start evaluator offers nothing", async () => {
    const made = parts();
    const evaluator = scriptedEvaluator(
      [{ isSufficient: false, nextIntents: [] }],
      { transformIntent: (intent) => `t:${intent}` },
    );

    await run(
      config(made, {
        localKnowledge: undefined,
        evaluator: evaluator.adapter,
      }),
    );

    // Without a fallback the external phase would have nothing to search for,
    // and the fallback has to be scoped like any other intent.
    expect(made.discovery.discover.mock.calls[0]?.[0]).toBe("t:a query");
  });

  it("uses the query itself as the fallback when there is no intent transform", async () => {
    // A workflow may configure no `transformIntent` at all. The raw query is
    // still a valid first intent, so the phase must not be left empty.
    const made = parts();
    const evaluator = scriptedEvaluator([
      { isSufficient: false, nextIntents: [] },
    ]);

    await run(
      config(made, {
        localKnowledge: undefined,
        evaluator: evaluator.adapter,
      }),
    );

    expect(made.discovery.discover.mock.calls[0]?.[0]).toBe("a query");
  });

  it("keeps the evaluator's intents instead of replacing them with the query", async () => {
    // The cold-start evaluator ran even though it was told there was no
    // evidence. If it did return intents, they are the better plan and the
    // query fallback must not overwrite them.
    const made = parts();
    const evaluator = scriptedEvaluator([
      { isSufficient: false, nextIntents: ["cold intent"] },
    ]);

    await run(
      config(made, {
        localKnowledge: undefined,
        evaluator: evaluator.adapter,
      }),
    );

    expect(made.discovery.discover.mock.calls[0]?.[0]).toBe("cold intent");
  });

  it("falls back to the query when a failed evaluator leaves no intents at all", async () => {
    // An evaluator that throws returns `false` without writing `pendingIntents`.
    // Combined with a checkpoint that restored an empty list, the external phase
    // would be handed zero intents and spend no rounds. The guard restores the
    // original query so a resumed run still searches for something.
    const made = parts();
    const failing: Config["evaluator"] = {
      evaluate: vi.fn(async () => {
        throw new Error("evaluator down");
      }),
      transformIntent: (intent) => `t:${intent}`,
    };

    const result = await run(
      config(made, {
        localKnowledge: undefined,
        evaluator: failing,
        resumeFrom: {
          completedStages: ["seeds", "local"],
          localSearches: 0,
          externalRounds: 0,
          state: { pendingIntents: [] },
        },
      }),
    );

    expect(made.discovery.discover.mock.calls[0]?.[0]).toBe("t:a query");
    expect(result.report).toBe("the report");
  });

  it("uses the raw query for that fallback when no transform is configured", async () => {
    const made = parts();
    const failing: Config["evaluator"] = {
      evaluate: vi.fn(async () => {
        throw new Error("evaluator down");
      }),
    };

    await run(
      config(made, {
        localKnowledge: undefined,
        evaluator: failing,
        resumeFrom: {
          completedStages: ["seeds", "local"],
          localSearches: 0,
          externalRounds: 0,
          state: { pendingIntents: [] },
        },
      }),
    );

    expect(made.discovery.discover.mock.calls[0]?.[0]).toBe("a query");
  });

  it("does not run the external phase when the budget is zero", async () => {
    const made = parts();

    await run(
      config(made, { budgets: { ...testBudgets, maxExternalRounds: 0 } }),
    );

    expect(made.discovery.discover).not.toHaveBeenCalled();
  });
});

describe("AgenticWorkflowLoop — final stage", () => {
  it("returns the synthesized report", async () => {
    const made = parts();

    const result = await run(config(made));

    expect(result.report).toBe("the report");
    expect(made.synthesize).toHaveBeenCalledTimes(1);
  });

  it("does not synthesize when there is nothing to answer from", async () => {
    const made = parts();

    const result = await run(
      config(made, {
        localKnowledge: undefined,
        externalDiscovery: undefined,
        budgets: { ...testBudgets, maxExternalRounds: 0 },
      }),
    );

    // Paying for a model call with no evidence can only produce invention.
    expect(made.synthesize).not.toHaveBeenCalled();
    expect(result.report).toBeUndefined();
    expect(result.source).toBe("none");
  });

  it("returns the bare result when no final adapter is configured", async () => {
    const made = parts();

    const result = await run(config(made, { finalAnswer: undefined }));

    expect(result.report).toBeUndefined();
    expect(result.context).toContain("ev");
  });

  it("labels each adapter's progress with the stage it ran in", async () => {
    const made = parts();
    const events: WorkflowProgressEvent[] = [];
    // The loop itself never emits: stages report through the context they are
    // handed. This adapter does what a real crawler does and emits per target.
    const discovery = discoveryHarness({
      discover: async () => ({ targets: ["t1"] }),
      executeBatch: async (targets, state, context) => {
        for (const target of targets) {
          context.emit({ message: `fetched ${target}`, addedEvidence: true });
          state.appendEvidence(`ev ${target}`);
        }
        return targets.length > 0;
      },
    });

    await run(
      config(
        { ...made, discovery },
        { onProgress: (event) => events.push(event) },
      ),
    );

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.workflow === "w")).toBe(true);
    // Everything this executor produced came from the external stage.
    expect(events.every((event) => event.stage === "external")).toBe(true);
  });
});

describe("AgenticWorkflowLoop — checkpoints", () => {
  function record() {
    const snapshots: WorkflowCheckpoint[] = [];
    return {
      snapshots,
      onCheckpoint: (snapshot: WorkflowCheckpoint) => snapshots.push(snapshot),
    };
  }

  it("reports the stages completed so far", async () => {
    const made = parts();
    const { snapshots, onCheckpoint } = record();

    await run(config(made, { seedTargets: ["a"], onCheckpoint }));

    const stages = snapshots.map((snapshot) =>
      snapshot.completedStages.join(","),
    );
    expect(stages.at(0)).toBe("seeds");
    expect(stages.at(-1)).toBe("seeds,local,external,critic");
  });

  it("carries the counters so a resume knows what was spent", async () => {
    const made = parts();
    const { snapshots, onCheckpoint } = record();

    await run(config(made, { onCheckpoint }));

    const last = snapshots.at(-1);
    expect(last?.localSearches).toBeGreaterThan(0);
    expect(last?.externalRounds).toBeGreaterThan(0);
  });

  it("swallows a checkpoint failure and warns", async () => {
    const made = parts();
    const { logger, spies } = makeSpyLogger();

    // The run still produces its answer, and the failure is reported rather
    // than thrown: a lost snapshot costs a re-run, never the result.
    const result = await run(
      config(made, {
        logger,
        onCheckpoint: () => {
          throw new Error("db down");
        },
      }),
    );
    expect(result.report).toBe("the report");
    // This fixture runs out of new sources before the critic is satisfied, so
    // the stop reason describes that rather than the checkpoint failure.
    expect(result.stopReason).toBe("no_new_sources");

    expect(spies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      expect.stringContaining("Checkpoint callback failed"),
    );
  });

  it("skips the stages a resume marked complete", async () => {
    const made = parts();

    const result = await run(
      config(made, {
        resumeFrom: {
          completedStages: ["seeds", "local"],
          localSearches: 1,
          externalRounds: 0,
          state: {},
        },
      }),
    );

    expect(made.local.calls).toEqual([]);
    expect(result.report).toBe("the report");
  });

  it("skips the critic when a resume marked it complete", async () => {
    const made = parts();

    await run(
      config(made, {
        resumeFrom: {
          completedStages: ["seeds", "local", "external", "critic"],
          localSearches: 1,
          externalRounds: 1,
          // A run that reached the critic has evidence; without it `finalize`
          // refuses to synthesize and the assertion below would pass vacuously.
          state: {
            evidenceSet: ["restored evidence"],
            contextIsSufficient: true,
          },
        },
      }),
    );

    expect(made.review).not.toHaveBeenCalled();
    expect(made.synthesize).toHaveBeenCalledTimes(1);
  });

  it("applies the checkpoint state before the first stage", async () => {
    const made = parts();

    const result = await run(
      config(made, {
        localKnowledge: undefined,
        externalDiscovery: undefined,
        budgets: { ...testBudgets, maxExternalRounds: 0 },
        resumeFrom: {
          completedStages: [],
          localSearches: 0,
          externalRounds: 0,
          state: { stopReason: "no_new_sources" },
        },
      }),
    );

    // The restored reason must survive `buildResult`, otherwise a resume
    // reports `budget_exhausted` for a run that finished cleanly.
    expect(result.stopReason).toBe("no_new_sources");
  });
});

describe("AgenticWorkflowLoop — cancellation", () => {
  it("returns an aborted result instead of throwing for a pre-aborted signal", async () => {
    const made = parts();
    const controller = new AbortController();
    controller.abort();

    const result = await run(config(made, { signal: controller.signal }));

    expect(result.stopReason).toBe("aborted");
    expect(made.local.calls).toEqual([]);
  });

  it("returns the partial result when the caller aborts mid-run", async () => {
    const made = parts();
    const controller = new AbortController();
    const synthesize = vi.fn(async () => {
      controller.abort();
      throw new Error("request aborted");
    });

    const result = await run(
      config(made, { signal: controller.signal, finalAnswer: { synthesize } }),
    );

    // A disconnect is not a server error; the caller gets what was collected.
    expect(result.stopReason).toBe("aborted");
    expect(result.report).toBeUndefined();
    expect(result.context).toContain("ev");
  });

  it("marks an abort that happens before any evidence", async () => {
    const made = parts();
    const controller = new AbortController();
    const fetchBatch = vi.fn(async () => {
      controller.abort();
      throw new Error("request aborted");
    });

    const result = await run(
      config(made, {
        signal: controller.signal,
        localKnowledge: { ...made.local.adapter, fetchBatch },
      }),
    );

    expect(result.stopReason).toBe("aborted");
    expect(result.source).toBe("none");
  });

  it("rethrows a failure that is not a cancellation", async () => {
    const made = parts();
    const fetchBatch = vi.fn(async () => {
      throw new Error("index unreachable");
    });

    await expect(
      run(
        config(made, {
          localKnowledge: { ...made.local.adapter, fetchBatch },
        }),
      ),
    ).rejects.toThrow("index unreachable");
  });
});

describe("AgenticWorkflowLoop — optional stages", () => {
  it("works with no critic configured", async () => {
    const made = parts();

    const result = await run(config(made, { critic: undefined }));

    expect(made.review).not.toHaveBeenCalled();
    expect(result.report).toBe("the report");
  });

  it("works with no local, external, critic or final stages", async () => {
    const made = parts();

    const result = await run(
      config(made, {
        localKnowledge: undefined,
        externalDiscovery: undefined,
        critic: undefined,
        finalAnswer: undefined,
        budgets: { ...testBudgets, maxExternalRounds: 0 },
      }),
    );

    expect(result.source).toBe("none");
    expect(result.report).toBeUndefined();
  });
});
