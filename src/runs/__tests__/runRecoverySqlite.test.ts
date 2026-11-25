import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config.js";
import { libLogger, resetLibLogger } from "~~/test/test-utils/logger.js";

/**
 * End-to-end recovery & retry tests against real SQLite (no mocked database).
 *
 * SQLite stores `runs.input` as a JSON string (`text`), unlike Postgres `jsonb`.
 * Both `startRunRecovery()` and `retryRun()` must parse `runs.input` via
 * `fromJson` so named resumers are selected instead of falling through.
 */

let env: LoadedConfig;

async function eventually(
  check: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(async () => {
  resetLibLogger();
  env = await loadConfig({
    dialect: "sqlite",
    logger: libLogger,
    overrides: {
      runs: {
        leaseTtlMs: 5_000,
        heartbeatIntervalMs: 1_000,
        recovery: {
          sweepIntervalMs: 50,
          maxAdoptPerSweep: 5,
          maxResumeAttempts: 3,
          unclaimedGraceMs: 60_000,
        },
      },
    },
  });
});

afterEach(async () => {
  await env.cleanup();
});

describe("SQLite runs.input JSON parsing in recovery and retry", () => {
  it("dispatches startRunRecovery to the named resumer stored in SQLite runs.input", async () => {
    const { createRun } = await import("~/models/runs.js");
    const { claimRun, finishRun } = await import("~/models/runLease.js");
    const { registerRunResumer } = await import("~/runs/resumerRegistry.js");
    const { startRunRecovery } = await import("~/runs/runRecovery.js");

    const adoptedBy: string[] = [];
    registerRunResumer({
      kind: "workflow",
      name: "alpha-workflow",
      adopt: async (row) => {
        if (!(await claimRun(row.id))) return;
        adoptedBy.push(`alpha:${row.id}`);
        await finishRun({ runId: row.id, stopReason: "adopted-alpha" });
      },
    });
    registerRunResumer({
      kind: "workflow",
      name: "beta-workflow",
      adopt: async (row) => {
        if (!(await claimRun(row.id))) return;
        adoptedBy.push(`beta:${row.id}`);
        await finishRun({ runId: row.id, stopReason: "adopted-beta" });
      },
    });

    const db = env.mod.getDb();
    await createRun({
      id: "sqlite-recover-named",
      kind: "workflow",
      query: "named query",
      input: { name: "beta-workflow" },
      userId: "u-1",
    });

    // Make the run look abandoned by a dead owner so recovery adopts it.
    await db
      .updateTable("runs")
      .set({
        owner: "dead-host:1:0",
        claimed_at: new Date(Date.now() - 60_000).toISOString(),
        started_at: new Date(Date.now() - 60_000).toISOString(),
      })
      .where("id", "=", "sqlite-recover-named")
      .execute();

    const stop = startRunRecovery();
    try {
      await eventually(async () => {
        const row = await db
          .selectFrom("runs")
          .select(["status", "stop_reason"])
          .where("id", "=", "sqlite-recover-named")
          .executeTakeFirstOrThrow();
        return row.status === "finished";
      }, "named resumer to adopt and finish the SQLite run");

      expect(adoptedBy).toEqual(["beta:sqlite-recover-named"]);
      const finalRow = await db
        .selectFrom("runs")
        .select(["status", "stop_reason"])
        .where("id", "=", "sqlite-recover-named")
        .executeTakeFirstOrThrow();
      expect(finalRow).toEqual({
        status: "finished",
        stop_reason: "adopted-beta",
      });
    } finally {
      stop();
    }
  });

  it("dispatches retryRun to the named resumer stored in SQLite runs.input", async () => {
    const { createRun, updateRun } = await import("~/models/runs.js");
    const { claimRun, finishRun } = await import("~/models/runLease.js");
    const { registerRunResumer } = await import("~/runs/resumerRegistry.js");
    const { retryRun } = await import("~/runs/retryRun.js");

    const adoptedBy: string[] = [];
    registerRunResumer({
      kind: "workflow",
      name: "retry-workflow",
      adopt: async (row) => {
        if (!(await claimRun(row.id))) return;
        adoptedBy.push(`retry:${row.id}`);
        await finishRun({ runId: row.id, stopReason: "retried" });
      },
    });

    const db = env.mod.getDb();
    await createRun({
      id: "sqlite-retry-named",
      kind: "workflow",
      query: "retry query",
      input: { name: "retry-workflow" },
      userId: "u-1",
    });
    await updateRun({
      id: "sqlite-retry-named",
      status: "failed",
      error: "transient",
      finished: true,
    });

    const outcome = await retryRun("sqlite-retry-named");
    expect(outcome).toEqual({
      ok: true,
      runId: "sqlite-retry-named",
      kind: "workflow",
      name: "retry-workflow",
      resumed: false,
      attempts: 1,
    });

    await eventually(async () => {
      const row = await db
        .selectFrom("runs")
        .select("status")
        .where("id", "=", "sqlite-retry-named")
        .executeTakeFirstOrThrow();
      return row.status === "finished";
    }, "named resumer to finish retried SQLite run");

    expect(adoptedBy).toEqual(["retry:sqlite-retry-named"]);
  });
});
