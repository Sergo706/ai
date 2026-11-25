import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The recovery sweep is what makes a crashed run finish instead of hanging. It
 * must never adopt a live run, must not spend money on a row nobody can resume,
 * and must stop after the attempt cap. All three are asserted here through the
 * public `startRunRecovery`, with the database and lease modules replaced.
 */

const h = vi.hoisted(() => ({
  findResumableRuns: vi.fn(),
  updateRun: vi.fn(async (_args: unknown) => {}),
  listRunResumers: vi.fn(),
  findRunResumer: vi.fn(),
}));

vi.mock("../../models/runLease.js", () => ({
  findResumableRuns: h.findResumableRuns,
  INSTANCE_ID: "test-host:1:0",
  getLeaseTtlMs: () => 60_000,
  reopenRunForRetry: vi.fn(),
}));

vi.mock("../../models/runs.js", () => ({
  updateRun: h.updateRun,
}));

vi.mock("../resumerRegistry.js", () => ({
  listRunResumers: h.listRunResumers,
  findRunResumer: h.findRunResumer,
}));

const { startRunRecovery, getMaxResumeAttempts } =
  await import("../runRecovery.js");
const MAX_RESUME_ATTEMPTS = getMaxResumeAttempts();

/**
 * A resumable row.
 *
 * Column names are the snake_case ones Kysely returns, not camelCase: the sweep
 * reads `claimed_at` and `started_at` straight off the row, so a fixture using
 * `claimedAt` would leave the grace-period branch reading `undefined` and
 * silently compare against `NaN`.
 */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    kind: "workflow",
    input: { name: "research-product" },
    attempts: 0,
    started_at: new Date(Date.now() - 60 * 60 * 1000),
    claimed_at: new Date(Date.now() - 60 * 60 * 1000),
    ...overrides,
  };
}

function resumer(adopt = vi.fn(async () => {})) {
  return { kind: "workflow", name: "research-product", adopt };
}

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  h.findResumableRuns.mockReset();
  h.updateRun.mockReset();
  h.listRunResumers.mockReset();
  h.findRunResumer.mockReset();
  h.updateRun.mockResolvedValue(undefined);
  h.findResumableRuns.mockResolvedValue([]);
  h.listRunResumers.mockReturnValue([resumer()]);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

/** Runs the initial sweep that `startRunRecovery` fires synchronously. */
async function sweep() {
  stop = startRunRecovery();
  // The first sweep is `void`ed, so let its microtasks settle.
  await vi.advanceTimersByTimeAsync(0);
}

describe("startRunRecovery", () => {
  it("does not query the database when nothing registered a resumer", async () => {
    h.listRunResumers.mockReturnValue([]);
    await sweep();
    // Polling for rows nobody can resume is pure load.
    expect(h.findResumableRuns).not.toHaveBeenCalled();
  });

  it("asks once per registered kind, not once per resumer", async () => {
    h.listRunResumers.mockReturnValue([
      resumer(),
      { kind: "workflow", name: "generate-video-script", adopt: vi.fn() },
      { kind: "research", adopt: vi.fn() },
    ]);
    await sweep();
    expect(h.findResumableRuns).toHaveBeenCalledTimes(2);
  });

  it("adopts a resumable row with its registered resumer", async () => {
    const adopt = vi.fn(async () => {});
    h.listRunResumers.mockReturnValue([resumer(adopt)]);
    h.findRunResumer.mockReturnValue(resumer(adopt));
    h.findResumableRuns.mockResolvedValue([row()]);

    await sweep();

    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1" }),
    );
  });

  it("looks the resumer up by the row's stored workflow name", async () => {
    h.findRunResumer.mockReturnValue(resumer());
    h.findResumableRuns.mockResolvedValue([row({ input: { name: "custom" } })]);

    await sweep();

    expect(h.findRunResumer).toHaveBeenCalledWith("workflow", "custom");
  });

  it("does nothing when no row is resumable", async () => {
    h.findResumableRuns.mockResolvedValue([]);
    await sweep();
    expect(h.updateRun).not.toHaveBeenCalled();
  });

  it("leaves a row with no resumer alone during the rollout grace period", async () => {
    // A rolling deploy boots the new build, whose sweep resolves the name. Closing
    // the row on the first pass would kill a run the new build is about to adopt.
    h.findRunResumer.mockReturnValue(undefined);
    h.findResumableRuns.mockResolvedValue([
      row({ claimed_at: new Date(Date.now() - 1_000) }),
    ]);

    await sweep();

    expect(h.updateRun).not.toHaveBeenCalled();
  });

  it("fails a row that no build has claimed for longer than the grace period", async () => {
    h.findRunResumer.mockReturnValue(undefined);
    h.findResumableRuns.mockResolvedValue([
      row({ claimed_at: new Date(Date.now() - 60 * 60 * 1000) }),
    ]);

    await sweep();

    expect(h.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "run-1",
        status: "failed",
        finished: true,
      }),
    );
  });

  it("names the missing runner in the failure it writes", async () => {
    h.findRunResumer.mockReturnValue(undefined);
    h.findResumableRuns.mockResolvedValue([
      row({ claimed_at: new Date(Date.now() - 60 * 60 * 1000) }),
    ]);

    await sweep();

    const args = h.updateRun.mock.calls[0]?.[0] as { error?: string };
    expect(args.error).toContain("No runner is registered");
    expect(args.error).toContain("research-product");
  });

  it("fails a run that has exhausted its resume attempts", async () => {
    h.findRunResumer.mockReturnValue(resumer());
    h.findResumableRuns.mockResolvedValue([
      row({ attempts: MAX_RESUME_ATTEMPTS }),
    ]);

    await sweep();

    expect(h.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", finished: true }),
    );
  });

  it("does not adopt a run at the attempt cap", async () => {
    const adopt = vi.fn(async () => {});
    h.findRunResumer.mockReturnValue(resumer(adopt));
    h.findResumableRuns.mockResolvedValue([
      row({ attempts: MAX_RESUME_ATTEMPTS }),
    ]);

    await sweep();

    expect(adopt).not.toHaveBeenCalled();
  });

  it("adopts a run one attempt below the cap", async () => {
    const adopt = vi.fn(async () => {});
    h.findRunResumer.mockReturnValue(resumer(adopt));
    h.findResumableRuns.mockResolvedValue([
      row({ attempts: MAX_RESUME_ATTEMPTS - 1 }),
    ]);

    await sweep();

    expect(adopt).toHaveBeenCalled();
  });

  it("keeps sweeping the rest after one adoption throws", async () => {
    const broken = vi.fn(async () => {
      throw new Error("adopt failed");
    });
    const healthy = vi.fn(async () => {});
    h.listRunResumers.mockReturnValue([resumer(healthy)]);
    h.findRunResumer
      .mockReturnValueOnce(resumer(broken))
      .mockReturnValueOnce(resumer(healthy));
    h.findResumableRuns.mockResolvedValue([row({ id: "a" }), row({ id: "b" })]);

    await sweep();

    // A single poison run must not stop the sweep from rescuing the next one.
    expect(healthy).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("survives a database failure and keeps its timer running", async () => {
    h.findResumableRuns.mockRejectedValue(new Error("db down"));
    stop = startRunRecovery();
    await vi.advanceTimersByTimeAsync(0);

    // The next tick must still query, which shows `sweeping` was released.
    h.findResumableRuns.mockResolvedValue([]);
    const before = h.findResumableRuns.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.findResumableRuns.mock.calls.length).toBeGreaterThan(before);
  });

  it("does not adopt a run twice in one pass", async () => {
    const adopt = vi.fn(async () => {});
    h.findRunResumer.mockReturnValue(resumer(adopt));
    h.findResumableRuns.mockResolvedValue([row()]);

    stop = startRunRecovery();
    await vi.advanceTimersByTimeAsync(0);
    // The initial sweep and the interval must not overlap.
    h.findResumableRuns.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it("stops querying after the returned stop function is called", async () => {
    stop = startRunRecovery();
    await vi.advanceTimersByTimeAsync(0);
    const before = h.findResumableRuns.mock.calls.length;
    stop();
    stop = undefined;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.findResumableRuns.mock.calls.length).toBe(before);
  });

  it("keeps sweeping on its interval", async () => {
    stop = startRunRecovery();
    await vi.advanceTimersByTimeAsync(0);
    const first = h.findResumableRuns.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.findResumableRuns.mock.calls.length).toBeGreaterThan(first);
  });
});
