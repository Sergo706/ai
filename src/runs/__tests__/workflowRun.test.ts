import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lifecycle itself is what these tests cover, so the three modules that
 * persist it are replaced. Everything else — the abort classifier, the transient
 * classifier, the payload shape — is the real implementation.
 *
 * `hoisted` holds the mocks because `vi.mock` factories are hoisted above the
 * imports, so they cannot close over ordinary `const`s declared below.
 */
const h = vi.hoisted(() => ({
  createRun: vi.fn(async (_args: unknown) => {}),
  updateRun: vi.fn(async (_args: unknown) => {}),
  claimRun: vi.fn(async (_runId: string) => true),
  finishRun: vi.fn(async (_args: unknown) => {}),
  releaseRun: vi.fn(async (_runId: string) => {}),
  startLeaseHeartbeat: vi.fn(
    (
      _runId: string,
      _onStop: (state: string) => void,
      _log: unknown,
    ): (() => void) =>
      () => {},
  ),
  saveCheckpoint: vi.fn(async (_args: unknown) => {}),
  loadCheckpoint: vi.fn(async (_runId: string): Promise<unknown> => null),
}));

vi.mock("../../models/runs.js", () => ({
  createRun: h.createRun,
  updateRun: h.updateRun,
}));

vi.mock("../../models/runLease.js", () => ({
  claimRun: h.claimRun,
  finishRun: h.finishRun,
  releaseRun: h.releaseRun,
  startLeaseHeartbeat: h.startLeaseHeartbeat,
}));

vi.mock("../../models/runCheckpoint.js", () => ({
  saveCheckpoint: h.saveCheckpoint,
  loadCheckpoint: h.loadCheckpoint,
}));

const { runWorkflow } = await import("../workflowRun.js");
const { WorkflowAbortedError: ResearchAbortedError } = await import(
  "../../agentic-loop/executionContext.js"
);

const log = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => log,
} as never;

const baseOptions = {
  kind: "workflow" as const,
  name: "research-product",
  query: "best drone",
  userId: "user-1",
  conversationId: 7,
};

const execution = {
  data: { answer: "ok" },
  source: "fresh",
  promptId: 42,
  generatedDocumentIds: ["doc-1"],
  isSufficient: true,
  stopReason: "sufficient",
  missingSearchTerms: ["price"],
  urls: ["https://a.example"],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.claimRun.mockResolvedValue(true);
  h.loadCheckpoint.mockResolvedValue(null);
  h.startLeaseHeartbeat.mockReturnValue(() => {});
});

describe("runWorkflow", () => {
  it("creates the run before doing any work and returns the envelope", async () => {
    const order: string[] = [];
    h.createRun.mockImplementation(async () => {
      order.push("createRun");
    });

    const result = await runWorkflow(
      baseOptions,
      async () => {
        order.push("execute");
        return execution;
      },
      log,
    );

    expect(order).toEqual(["createRun", "execute"]);
    expect(h.claimRun).toHaveBeenCalledTimes(1);

    expect(result).toEqual({
      success: true,
      source: "fresh",
      promptId: 42,
      generatedDocumentIds: ["doc-1"],
      isSufficient: true,
      stopReason: "sufficient",
      missingSearchTerms: ["price"],
      urls: ["https://a.example"],
      data: { answer: "ok" },
    });
  });

  it("stores the workflow name in the run input so a resume can route it", async () => {
    await runWorkflow(
      { ...baseOptions, input: { locale: "de-DE", forceFreshWeb: true } },
      async () => execution,
      log,
    );

    const created = h.createRun.mock.calls[0]?.[0] as {
      kind: string;
      query: string;
      userId: string | null;
      conversationId: number | null;
      input: Record<string, unknown>;
    };

    // `findRunResumer` matches on `input.name`; without it an adoption falls
    // back to the unnamed resumer for the kind and replays the wrong workflow.
    expect(created.input).toEqual({
      name: "research-product",
      locale: "de-DE",
      forceFreshWeb: true,
    });
    expect(created.kind).toBe("workflow");
    expect(created.query).toBe("best drone");
    expect(created.userId).toBe("user-1");
    expect(created.conversationId).toBe(7);
  });

  it("omits the name key entirely for a research run", async () => {
    await runWorkflow(
      {
        ...baseOptions,
        kind: "chat",
        name: undefined,
        input: { researchType: "general", locale: "en-US" },
      },
      async () => execution,
      log,
    );

    const created = h.createRun.mock.calls[0]?.[0] as {
      kind: string;
      input: Record<string, unknown>;
    };

    expect(created.kind).toBe("research");
    expect(created.input).not.toHaveProperty("name");
    expect(created.input).toEqual({
      researchType: "general",
      locale: "en-US",
    });
  });

  it("reports the run id before the work starts so a client can subscribe", async () => {
    const seen: string[] = [];

    await runWorkflow(
      {
        ...baseOptions,
        onRunStarted: (runId) => {
          seen.push(runId);
        },
      },
      async (ctx) => {
        // The subscriber needs the id while the loop is still running, not after.
        expect(seen).toEqual([ctx.runId]);
        return execution;
      },
      log,
    );

    expect(seen).toHaveLength(1);
  });

  it("finishes the run with the payload a retry or a reader depends on", async () => {
    let runId = "";

    await runWorkflow(
      {
        ...baseOptions,
        onRunStarted: (id) => {
          runId = id;
        },
      },
      async () => execution,
      log,
    );

    // The id is named exactly rather than matched as "any string": a payload
    // written under a different id is invisible to the client polling this run.
    expect(h.finishRun).toHaveBeenCalledWith({
      runId,
      stopReason: "sufficient",
      partial: {
        report: { answer: "ok" },
        isSufficient: true,
        missingIntents: ["price"],
      },
    });
  });

  it("hands the prompt id back to the caller rather than persisting it", async () => {
    // `finishRun` writes the row's terminal state; the prompt id belongs to the
    // returned payload, so it must not leak into the persisted shape.
    const result = await runWorkflow(baseOptions, async () => execution, log);

    const args = h.finishRun.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).not.toHaveProperty("promptId");
    expect(result.promptId).toBe(42);
  });

  it("marks a transient failure as interrupted when a checkpoint exists", async () => {
    h.loadCheckpoint.mockResolvedValue({ urls: [] });
    const boom = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });

    await expect(
      runWorkflow(
        baseOptions,
        async () => {
          throw boom;
        },
        log,
      ),
    ).rejects.toBe(boom);

    const args = h.updateRun.mock.calls[0]?.[0] as {
      status: string;
      error: string;
      finished: boolean;
    };
    expect(args.status).toBe("interrupted");
    expect(args.error).toBe("socket hang up");
    expect(args.finished).toBe(true);
    expect(h.finishRun).not.toHaveBeenCalled();
  });

  it("marks a transient failure as failed when there is nothing to resume", async () => {
    h.loadCheckpoint.mockResolvedValue(null);
    const boom = Object.assign(new Error("upstream"), { status: 503 });

    await expect(
      runWorkflow(
        baseOptions,
        async () => {
          throw boom;
        },
        log,
      ),
    ).rejects.toBe(boom);

    // No snapshot means a retry would repeat the whole paid run from zero, so
    // the row must not advertise itself as resumable.
    expect((h.updateRun.mock.calls[0]?.[0] as { status: string }).status).toBe(
      "failed",
    );
  });

  it("marks a permanent failure as failed even with a checkpoint", async () => {
    h.loadCheckpoint.mockResolvedValue({ urls: [] });
    const boom = new Error("the model refused");

    await expect(
      runWorkflow(
        baseOptions,
        async () => {
          throw boom;
        },
        log,
      ),
    ).rejects.toBe(boom);

    expect((h.updateRun.mock.calls[0]?.[0] as { status: string }).status).toBe(
      "failed",
    );
  });

  it("distinguishes an abort from a failure", async () => {
    const aborted = new ResearchAbortedError("research");

    await expect(
      runWorkflow(
        baseOptions,
        async () => {
          throw aborted;
        },
        log,
      ),
    ).rejects.toBe(aborted);

    // An abort is a decision, not a defect: it must not read as "failed" in a
    // dashboard or trigger the same alerting.
    expect((h.updateRun.mock.calls[0]?.[0] as { status: string }).status).toBe(
      "aborted",
    );
  });

  it("treats an already-aborted caller signal as an abort, not as transient", async () => {
    const controller = new AbortController();
    controller.abort();
    const boom = Object.assign(new Error("aborted"), { code: "ECONNRESET" });

    await expect(
      runWorkflow(
        { ...baseOptions, signal: controller.signal },
        async () => {
          throw boom;
        },
        log,
      ),
    ).rejects.toBe(boom);

    expect((h.updateRun.mock.calls[0]?.[0] as { status: string }).status).toBe(
      "aborted",
    );
  });

  it("hands the work a checkpoint writer bound to its own run id", async () => {
    let seenRunId = "";

    await runWorkflow(
      {
        ...baseOptions,
        onRunStarted: (id) => {
          seenRunId = id;
        },
      },
      async (ctx) => {
        ctx.saveCheckpoint({ urls: ["https://a.example"] } as never);
        return execution;
      },
      log,
    );

    expect(h.saveCheckpoint).toHaveBeenCalledWith({
      runId: seenRunId,
      snapshot: { urls: ["https://a.example"] },
    });
    // The run that was created is the run the snapshot is keyed to.
    const created = h.createRun.mock.calls[0]?.[0] as { id: string };
    const saved = h.saveCheckpoint.mock.calls[0]?.[0] as { runId: string };
    expect(saved.runId).toBe(created.id);
  });

  it("exposes the stored checkpoint for the work to resume from", async () => {
    h.loadCheckpoint.mockResolvedValue({ urls: ["https://old.example"] });

    await runWorkflow(
      baseOptions,
      async (ctx) => {
        expect(await ctx.loadCheckpoint()).toEqual({
          urls: ["https://old.example"],
        });
        return execution;
      },
      log,
    );
  });

  it("always releases the lease, on success and on failure", async () => {
    await runWorkflow(baseOptions, async () => execution, log);
    expect(h.releaseRun).toHaveBeenCalledTimes(1);

    h.releaseRun.mockClear();
    await expect(
      runWorkflow(
        baseOptions,
        async () => {
          throw new Error("nope");
        },
        log,
      ),
    ).rejects.toThrow("nope");
    expect(h.releaseRun).toHaveBeenCalledTimes(1);
  });

  it("stops the heartbeat it started, exactly once", async () => {
    const stop = vi.fn();
    h.startLeaseHeartbeat.mockReturnValue(stop);

    await runWorkflow(baseOptions, async () => execution, log);

    // A leaked interval keeps a dead run looking alive until its lease expires.
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not create a row when resuming, and claims the existing one", async () => {
    await runWorkflow(
      { ...baseOptions, resumeRunId: "run-existing" },
      async (ctx) => {
        expect(ctx.runId).toBe("run-existing");
        return execution;
      },
      log,
    );

    expect(h.createRun).not.toHaveBeenCalled();
    expect(h.claimRun).toHaveBeenCalledWith("run-existing");
  });

  it("refuses to resume a run another process already owns", async () => {
    h.claimRun.mockResolvedValue(false);

    await expect(
      runWorkflow(
        { ...baseOptions, resumeRunId: "run-taken" },
        async () => {
          throw new Error("must never run");
        },
        log,
      ),
    ).rejects.toThrow("already owned by another process");

    expect(h.finishRun).not.toHaveBeenCalled();
    // The other replica owns the row; this one must not overwrite its status.
    expect(h.updateRun).not.toHaveBeenCalled();
  });

  it("does not record a status when the heartbeat says the lease was closed elsewhere", async () => {
    h.startLeaseHeartbeat.mockImplementation(
      (_runId: string, onStop: (state: string) => void) => {
        // Simulate the other replica closing the row mid-run.
        onStop("terminated");
        return () => {};
      },
    );
    const boom = new Error("stopped");

    await expect(
      runWorkflow(
        baseOptions,
        async () => {
          throw boom;
        },
        log,
      ),
    ).rejects.toBe(boom);

    // Writing `failed` here would overwrite the terminal state the other
    // replica already committed.
    expect(h.updateRun).not.toHaveBeenCalled();
    expect(h.releaseRun).toHaveBeenCalled();
  });

  it("does not overwrite the abort another replica already recorded", async () => {
    h.startLeaseHeartbeat.mockImplementation(
      (_runId: string, onStop: (state: string) => void) => {
        onStop("aborted");
        return () => {};
      },
    );

    await expect(
      runWorkflow(
        baseOptions,
        async () => {
          throw new Error("stopped");
        },
        log,
      ),
    ).rejects.toThrow("stopped");

    // The other replica reached `requestAbort`, which already wrote
    // `status = 'aborted'`. Repeating the write would clobber `finishedAt` and
    // race a second status transition on the same row for no gain.
    expect(h.updateRun).not.toHaveBeenCalled();
    expect(h.releaseRun).toHaveBeenCalled();
  });

  it("does not write a status over a run another replica owns", async () => {
    // `claimRun` lost, so no row of ours exists. The `finally` still releases,
    // and the release is a no-op because the owner is not us.
    h.claimRun.mockResolvedValue(false);

    await expect(
      runWorkflow(
        { ...baseOptions, resumeRunId: "run-taken" },
        async () => execution,
        log,
      ),
    ).rejects.toThrow("already owned");

    expect(h.updateRun).not.toHaveBeenCalled();
    expect(h.finishRun).not.toHaveBeenCalled();
  });
});
