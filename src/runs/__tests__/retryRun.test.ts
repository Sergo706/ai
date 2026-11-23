import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredRun } from "../../types/RunModel.js";
import type { RunResumer } from "../types.js";

/**
 * `retryRun` decides whether a run can be put back to work. Every refusal has a
 * different user-facing meaning, so the tests pin which condition maps to which
 * reason — the retry button renders its message straight from here.
 */

const h = vi.hoisted(() => ({
  getRun: vi.fn(),
  findRunResumer: vi.fn(),
  getRunById: vi.fn(),
  reopenRunForRetry: vi.fn(),
}));

vi.mock("../runRegistry.js", () => ({ getRun: h.getRun }));
vi.mock("../resumerRegistry.js", () => ({
  findRunResumer: h.findRunResumer,
}));
vi.mock("../../models/runs.js", () => ({ getRunById: h.getRunById }));
vi.mock("../../models/runLease.js", () => ({
  reopenRunForRetry: h.reopenRunForRetry,
  // `runRecovery` reads the lease duration to size its sweep interval, and
  // `retryRun` imports the attempt cap from there, so the constant has to exist
  // on the mock even though this suite never uses it.
  LEASE_TTL_MS: 60_000,
}));

const { retryRun } = await import("../retryRun.js");
const { MAX_RESUME_ATTEMPTS } = await import("../runRecovery.js");

function row(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id: "run-1",
    kind: "workflow",
    status: "aborted",
    query: "q",
    input: { name: "research-product" },
    attempts: 0,
    checkpoint: null,
    ...overrides,
  } as StoredRun;
}

function resumer(adopt = vi.fn(async () => {})): RunResumer {
  return {
    kind: "workflow",
    name: "research-product",
    adopt,
  } as unknown as RunResumer;
}

beforeEach(() => {
  h.getRun.mockReset();
  h.findRunResumer.mockReset();
  h.getRunById.mockReset();
  h.reopenRunForRetry.mockReset();
  h.getRun.mockReturnValue(undefined);
  h.findRunResumer.mockReturnValue(resumer());
  h.reopenRunForRetry.mockResolvedValue({ checkpoint: null, attempts: 1 });
});

describe("retryRun", () => {
  it("refuses an unknown run", async () => {
    h.getRunById.mockResolvedValue(null);
    const outcome = await retryRun("run-1");
    expect(outcome).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("refuses a run whose kind has no registered resumer", async () => {
    h.getRunById.mockResolvedValue(row());
    h.findRunResumer.mockReturnValue(undefined);

    const outcome = await retryRun("run-1");

    expect(outcome).toMatchObject({ ok: false, reason: "no_runner" });
    // The message has to say which kind, because "no runner" alone is not
    // actionable for an operator.
    expect(!outcome.ok && outcome.message).toMatch(/workflow/);
  });

  it("names the workflow in the no_runner message when it has a name", async () => {
    h.getRunById.mockResolvedValue(row());
    h.findRunResumer.mockReturnValue(undefined);

    const outcome = await retryRun("run-1");

    expect(!outcome.ok && outcome.message).toMatch(/research-product/);
  });

  it("looks the resumer up by the run's stored workflow name", async () => {
    h.getRunById.mockResolvedValue(row());
    await retryRun("run-1");
    expect(h.findRunResumer).toHaveBeenCalledWith(
      "workflow",
      "research-product",
    );
  });

  it("passes undefined for a run with no stored name", async () => {
    h.getRunById.mockResolvedValue(row({ kind: "chat", input: {} }));
    await retryRun("run-1");
    expect(h.findRunResumer).toHaveBeenCalledWith("research", undefined);
  });

  it("refuses a run that is still running, in this process or elsewhere", async () => {
    h.getRunById.mockResolvedValue(row({ status: "running" }));

    const outcome = await retryRun("run-1");

    expect(outcome).toMatchObject({ ok: false, reason: "already_running" });
    // The recovery sweep owns a stale running row; retrying it here would run
    // the same work twice.
    expect(!outcome.ok && outcome.message).toMatch(/sweep|replica/);
  });

  it("distinguishes a locally executing run from a stale row", async () => {
    h.getRunById.mockResolvedValue(row({ status: "running" }));
    h.getRun.mockReturnValue({ id: "run-1" });

    const outcome = await retryRun("run-1");

    expect(!outcome.ok && outcome.message).toMatch(/this replica/);
  });

  it("refuses a run that has used every resume", async () => {
    // The cap comes from `RUNS_MAX_RESUME_ATTEMPTS`; reading the constant keeps
    // this test honest if the default changes.
    h.getRunById.mockResolvedValue(row({ attempts: MAX_RESUME_ATTEMPTS }));

    const outcome = await retryRun("run-1");

    expect(outcome).toMatchObject({
      ok: false,
      reason: "attempts_exhausted",
      attempts: MAX_RESUME_ATTEMPTS,
    });
    expect(!outcome.ok && outcome.message).toMatch(/new run/);
  });

  it("accepts a run one attempt below the cap", async () => {
    h.getRunById.mockResolvedValue(row({ attempts: MAX_RESUME_ATTEMPTS - 1 }));
    const outcome = await retryRun("run-1");
    expect(outcome.ok).toBe(true);
  });

  it("refuses when the row changed between the read and the reopen", async () => {
    h.getRunById
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ status: "running" }));
    h.reopenRunForRetry.mockResolvedValue(null);

    const outcome = await retryRun("run-1");

    expect(outcome).toMatchObject({ ok: false, reason: "already_running" });
    // The current state is reported rather than the state from the first read.
    expect(!outcome.ok && outcome.status).toBe("running");
  });

  it("reopens a run and hands it to its resumer", async () => {
    const adopt = vi.fn(async () => {});
    h.getRunById.mockResolvedValue(row());
    h.findRunResumer.mockReturnValue(resumer(adopt));

    const outcome = await retryRun("run-1");

    expect(outcome).toMatchObject({
      ok: true,
      runId: "run-1",
      kind: "workflow",
      name: "research-product",
      resumed: false,
      attempts: 1,
    });
    // `adopt` is fire-and-forget so the response is not held open for the whole
    // run; it is still called with the reopened row.
    await vi.waitFor(() => {
      expect(adopt).toHaveBeenCalled();
    });
  });

  it("reports resumed true when the reopened row kept its checkpoint", async () => {
    h.getRunById.mockResolvedValue(row());
    h.reopenRunForRetry.mockResolvedValue({
      checkpoint: { version: 1, phase: "web", roundsDone: 2, state: {} },
      attempts: 2,
    });

    const outcome = await retryRun("run-1");

    expect(outcome).toMatchObject({ ok: true, resumed: true, attempts: 2 });
  });

  it("reports the attempts count after the reopen, not before", async () => {
    h.getRunById.mockResolvedValue(row({ attempts: 1 }));
    h.reopenRunForRetry.mockResolvedValue({ checkpoint: null, attempts: 2 });

    const outcome = await retryRun("run-1");

    expect(outcome.ok && outcome.attempts).toBe(2);
  });

  it("accepts an aborted run, which the sweep would never touch", async () => {
    h.getRunById.mockResolvedValue(row({ status: "aborted" }));
    const outcome = await retryRun("run-1");
    expect(outcome.ok).toBe(true);
  });

  it("accepts a failed run", async () => {
    h.getRunById.mockResolvedValue(row({ status: "failed" }));
    const outcome = await retryRun("run-1");
    expect(outcome.ok).toBe(true);
  });

  it("accepts an interrupted run", async () => {
    h.getRunById.mockResolvedValue(row({ status: "interrupted" }));
    const outcome = await retryRun("run-1");
    expect(outcome.ok).toBe(true);
  });

  it("does not reopen a run it already refused", async () => {
    h.getRunById.mockResolvedValue(row({ attempts: MAX_RESUME_ATTEMPTS + 4 }));
    await retryRun("run-1");
    expect(h.reopenRunForRetry).not.toHaveBeenCalled();
  });

  it("does not reject when the resumer throws, because the response is already sent", async () => {
    const adopt = vi.fn(async () => {
      throw new Error("workflow exploded");
    });
    h.getRunById.mockResolvedValue(row());
    h.findRunResumer.mockReturnValue(resumer(adopt));

    // `void resumer.adopt(...).catch(...)` is what keeps this from becoming an
    // unhandled rejection that takes the process down.
    await expect(retryRun("run-1")).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => {
      expect(adopt).toHaveBeenCalled();
    });
  });
});
