import { describe, expect, it } from "vitest";
import type { SseFrame } from "~/types/Chat.js";
import {
  attachDetachedWorkflow,
  workflowStreamWithRegistry,
} from "../detachedWorkflow.js";
import { getRun } from "../runRegistry.js";

/**
 * These tests cover the difference between "the work survives a disconnect" and
 * "the output survives a disconnect".
 *
 * Before a run handle was registered, closing the tab did not stop the loop
 * (nothing aborts on `res.on("close")`), but `GET /api/runs/{id}/stream` could
 * not replay anything, because no events had ever been published. The run was
 * alive and unreadable at the same time — which from the user's side is
 * indistinguishable from the run having died.
 */

const log = {
  debug: () => {},
  warn: () => {},
} as never;

const silent = (): void => {};

describe("attachDetachedWorkflow", () => {
  it("registers a live run under the id the workflow will use", () => {
    const detached = attachDetachedWorkflow({
      runId: "run-a",
      kind: "workflow",
      conversationId: 5,
      log,
    });

    // The handle is what `GET /api/runs` lists and what abort's local path
    // looks up, so its id has to match the one the workflow writes to Postgres.
    // A mismatch would produce two runs: one observable, one real.
    expect(getRun("run-a")).toBe(detached.run);
    expect(detached.run.kind).toBe("workflow");
    expect(detached.run.conversationId).toBe(5);
    expect(detached.run.status).toBe("running");
    expect(detached.run.subscribers.size).toBe(0);
  });

  it("publishes every frame it also writes to the response", () => {
    const detached = attachDetachedWorkflow({
      runId: "run-b",
      kind: "chat",
      log,
    });
    const written: SseFrame[] = [];
    const emit = detached.tee((frame) => written.push(frame));

    emit({ type: "research_url", url: "https://a.example" });

    // The replay must contain exactly what the live response contained. If the
    // registry copy diverged, a reattaching client would see a different run
    // than the one that is still streaming.
    expect(written).toEqual([
      { type: "research_url", url: "https://a.example" },
    ]);
    expect(detached.run.events).toEqual(written);
  });

  it("publishes the result and a terminal done on success", () => {
    const detached = attachDetachedWorkflow({
      runId: "run-c",
      kind: "workflow",
      log,
    });
    const result: SseFrame = { type: "research_result", success: true };

    detached.finish(result);

    // `done` is what tells a replayed stream to close instead of waiting for
    // more events on a run that has already ended.
    expect(detached.run.events).toEqual([result, { type: "done" }]);
    expect(detached.run.status).toBe("finished");
  });

  it("publishes an error frame and marks the run failed on failure", () => {
    const detached = attachDetachedWorkflow({
      runId: "run-d",
      kind: "workflow",
      log,
    });

    detached.fail();

    expect(detached.run.status).toBe("failed");
    const last = detached.run.events.at(-1);
    expect(last?.type).toBe("error");
  });

  it("does not leak a thrown message into the published error frame", () => {
    const detached = attachDetachedWorkflow({
      runId: "run-e",
      kind: "workflow",
      log,
    });

    detached.fail();

    // The real error is logged by the route. The frame is client-facing, so it
    // must stay generic — a connection string in an SSE frame is a leak.
    expect(JSON.stringify(detached.run.events)).not.toMatch(
      /secret|password|postgres:/i,
    );
  });

  it("gives the workflow a signal that aborts when stop is pressed locally", () => {
    const detached = attachDetachedWorkflow({
      runId: "run-f",
      kind: "workflow",
      log,
    });

    expect(detached.run.controller.signal.aborted).toBe(false);
    detached.run.controller.abort();
    expect(detached.run.controller.signal.aborted).toBe(true);
  });

  it("forwards frames to subscribers so an attached client sees them live", () => {
    const detached = attachDetachedWorkflow({
      runId: "run-g",
      kind: "workflow",
      log,
    });
    const seen: string[] = [];
    detached.run.subscribers.add((event) => seen.push(event.type));

    const emit = detached.tee(silent);
    emit({ type: "research_start", runId: "run-g" });
    detached.finish({ type: "research_result" });

    expect(seen).toEqual(["research_start", "research_result", "done"]);
  });
});

/**
 * `workflowStreamWithRegistry` is the single place the research-family routes
 * get their SSE body from. Three things have to happen in order, and each has
 * been the source of a real bug: the handle must exist before the work starts,
 * every frame must be published as well as written, and the registry must reach
 * a terminal state on *both* paths — including after a throw, where a run left
 * `running` looks alive until its lease expires.
 */

/** Drains the frames a workflow stream wrote, without waiting for a close. */
async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<Record<string, unknown>[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const step = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => {
          setTimeout(() => {
            resolve(null);
          }, 20);
        }),
      ]);
      if (step === null || step.done) break;
      text += decoder.decode(step.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map(
      (block) =>
        JSON.parse(block.slice("data: ".length)) as Record<string, unknown>,
    );
}

describe("workflowStreamWithRegistry", () => {
  it("registers the run before the work is allowed to start", async () => {
    let existedAtStart = false;

    await collect(
      workflowStreamWithRegistry({
        runId: "wf-a",
        kind: "chat",
        log,
        execute: () => {
          // The handle has to be readable while the work runs, otherwise a
          // reader attaching mid-run finds nothing to attach to.
          existedAtStart = getRun("wf-a") !== undefined;
          return Promise.resolve({ type: "research_result" });
        },
      }),
    );

    expect(existedAtStart).toBe(true);
  });

  it("writes the execute result and a terminal done", async () => {
    const frames = await collect(
      workflowStreamWithRegistry({
        runId: "wf-b",
        kind: "workflow",
        log,
        execute: async () => ({ type: "workflow_result", ok: true }),
      }),
    );

    expect(frames).toEqual([
      { type: "workflow_result", ok: true },
      { type: "done" },
    ]);
  });

  it("publishes every frame the workflow emits, not just the result", async () => {
    await collect(
      workflowStreamWithRegistry({
        runId: "wf-c",
        kind: "chat",
        log,
        execute: async ({ emit }) => {
          emit({ type: "research_start", runId: "wf-c" });
          emit({ type: "research_url", url: "https://a.example" });
          return { type: "research_result" };
        },
      }),
    );

    const run = getRun("wf-c");
    expect(run?.events.map((event) => event.type)).toEqual([
      "research_start",
      "research_url",
      "research_result",
      "done",
    ]);
  });

  it("marks the run finished when the work succeeds", async () => {
    await collect(
      workflowStreamWithRegistry({
        runId: "wf-d",
        kind: "workflow",
        log,
        execute: async () => ({ type: "workflow_result" }),
      }),
    );

    expect(getRun("wf-d")?.status).toBe("finished");
  });

  it("passes an un-aborted signal to the work", async () => {
    let abortedAtStart: boolean | undefined;

    await collect(
      workflowStreamWithRegistry({
        runId: "wf-e",
        kind: "workflow",
        log,
        execute: ({ signal }) => {
          abortedAtStart = signal.aborted;
          return Promise.resolve({ type: "workflow_result" });
        },
      }),
    );

    expect(abortedAtStart).toBe(false);
  });

  it("aborts the signal the work was given when stop is pressed", async () => {
    let captured: AbortSignal | undefined;

    await collect(
      workflowStreamWithRegistry({
        runId: "wf-f",
        kind: "workflow",
        log,
        execute: ({ signal }) => {
          captured = signal;
          getRun("wf-f")?.controller.abort();
          return Promise.resolve({ type: "workflow_result" });
        },
      }),
    );

    expect(captured?.aborted).toBe(true);
  });

  it("emits an error frame, reports it, and marks the run failed", async () => {
    const failures: unknown[] = [];

    const frames = await collect(
      workflowStreamWithRegistry({
        runId: "wf-g",
        kind: "workflow",
        log,
        onError: (err) => failures.push(err),
        execute: () => Promise.reject(new Error("boom")),
      }),
    );

    expect(frames).toContainEqual({
      type: "error",
      message: "Server error please try again",
    });
    expect(getRun("wf-g")?.status).toBe("failed");
    expect(failures).toHaveLength(1);
  });

  it("publishes the failure to the registry so a reader replays it", async () => {
    await collect(
      workflowStreamWithRegistry({
        runId: "wf-h",
        kind: "chat",
        log,
        execute: () => Promise.reject(new Error("boom")),
      }),
    );

    // A run that failed silently would look like one still thinking.
    expect(getRun("wf-h")?.events.map((event) => event.type)).toEqual([
      "error",
    ]);
  });

  it("still terminates the run when the error handler itself throws", async () => {
    await collect(
      workflowStreamWithRegistry({
        runId: "wf-i",
        kind: "workflow",
        log,
        onError: () => {
          throw new Error("handler failed");
        },
        execute: () => Promise.reject(new Error("boom")),
      }),
    );

    expect(getRun("wf-i")?.status).toBe("failed");
  });

  it("never leaves a run in the running state after a throw", async () => {
    for (const mode of ["resolve", "reject"] as const) {
      const id = `wf-${mode}`;
      await collect(
        workflowStreamWithRegistry({
          runId: id,
          kind: "workflow",
          log,
          execute: () =>
            mode === "resolve"
              ? Promise.resolve({ type: "workflow_result" })
              : Promise.reject(new Error(mode)),
        }),
      );

      expect(getRun(id)?.status).not.toBe("running");
    }
  });
});
