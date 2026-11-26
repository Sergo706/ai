import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Kysely } from "kysely";

import type { Database, RunStatus } from "~/db/schema.js";
import { toJson } from "~/db/utils.js";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";
import { libLogger, libLog } from "~~/test/test-utils/logger";

/**
 * Cross-dialect parity for the run lease, exercised on `better-sqlite3`.
 *
 * `models.int.test.ts` runs the same protocol against pgvector and
 * `runLifecycle.test.ts` covers the state machine behaviour on sqlite. This
 * suite is narrower and deliberately redundant: it pins the three guarantees
 * that made the lease portable in the first place, so a refactor cannot quietly
 * reintroduce the sqlite-only failure modes listed below.
 *
 * 1. **Every timestamp is a string.** `better-sqlite3` binds only numbers,
 *    strings, bigints, buffers and null — passing a `Date` throws
 *    `SQLite3 can only bind numbers, strings, bigints, buffers, and null`.
 *    A `Date` in a `SET` throws just like one in a `WHERE`, so a claim that
 *    succeeds proves both sides go through `timestamp()`.
 * 2. **The lease is owner-scoped.** `releaseRun` and `markStaleRunsInterrupted`
 *    must never touch a row another replica owns. On sqlite this is the only
 *    thing standing between a zombie `finally` block and a duplicated run.
 * 3. **Checkpoints round-trip as objects.** SQLite hands the column back as the
 *    text we wrote, so `loadCheckpoint` has to `JSON.parse` it. Postgres'
 *    `jsonb` returns an object either way, which is exactly why a regression
 *    here would pass the pg suite and fail in production.
 */

type Lease = typeof import("../runLease.js");
type Checkpoint = typeof import("../runCheckpoint.js");

interface Harness {
  env: LoadedConfig;
  db: Kysely<Database>;
  lease: Lease;
  checkpoints: Checkpoint;
}

let harness: Harness;

beforeAll(async () => {
  const env = await loadConfig({
    dialect: "sqlite",
    logger: libLogger,
    overrides: {
      runs: { leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000 },
    },
  });
  // `runLease` captures `LEASE_TTL_MS` at import time, so the modules must be
  // imported after the configuration they belong to exists.
  const lease = await import("../runLease.js");
  const checkpoints = await import("../runCheckpoint.js");
  harness = { env, db: env.mod.getDb(), lease, checkpoints };
});

beforeEach(async () => {
  await harness.env.truncate();
});

afterAll(async () => {
  await harness.env.cleanup();
});

/** Seeds a `runs` row directly, bypassing the lease protocol. */
async function seedRun(args: {
  id: string;
  status?: RunStatus;
  owner?: string | null;
  claimedAt?: string | null;
  checkpoint?: unknown;
  attempts?: number;
}): Promise<void> {
  await harness.db
    .insertInto("runs")
    .values({
      id: args.id,
      kind: "workflow",
      query: "q",
      status: args.status ?? "running",
      owner: args.owner ?? null,
      claimed_at: args.claimedAt ?? null,
      started_at: new Date().toISOString(),
      checkpoint: toJson(args.checkpoint ?? null),
      attempts: args.attempts ?? 0,
    })
    .execute();
}

async function readRun(id: string) {
  return await harness.db
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

/** An ISO-8601 string with a real time component, i.e. not `longAgo()`. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function longAgo(ms = 60_000): string {
  return new Date(Date.now() - ms).toISOString();
}

describe("claimRun on better-sqlite3", () => {
  it("binds the lease timestamps as strings instead of Dates", async () => {
    await seedRun({ id: "sqlite-claim", status: "interrupted" });

    expect(await harness.lease.claimRun("sqlite-claim")).toBe(true);

    const row = await readRun("sqlite-claim");
    expect(row.status).toBe("running");
    expect(row.owner).toBe(harness.lease.INSTANCE_ID);
    // A `Date` would have thrown before the row was written, so reaching this
    // line already proves the binding is portable; the shape check pins the
    // format `timestamp()` promises.
    expect(row.claimed_at).toMatch(ISO);
    expect(new Date(row.claimed_at as string).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    // Reopening an `interrupted` row *is* a resume, so the counter moves. The
    // "fresh claim adds nothing" case is covered by the peer-race test below.
    expect(row.attempts).toBe(1);
  });

  it("does not increment attempts for a run nobody has claimed yet", async () => {
    await seedRun({ id: "sqlite-fresh", claimedAt: null });

    expect(await harness.lease.claimRun("sqlite-fresh")).toBe(true);

    // `running` with no owner and no claim is the one case that is not a
    // resume, so the sweep's cap is not spent on a first attempt.
    expect((await readRun("sqlite-fresh")).attempts).toBe(0);
  });

  it("increments attempts when taking over from a dead replica", async () => {
    await seedRun({
      id: "sqlite-retry",
      owner: "dead:1:x",
      claimedAt: longAgo(),
    });

    expect(await harness.lease.claimRun("sqlite-retry")).toBe(true);

    const row = await readRun("sqlite-retry");
    expect(row.owner).toBe(harness.lease.INSTANCE_ID);
    expect(row.attempts).toBe(1);
  });

  it("rejects a lease that another replica is still holding", async () => {
    // Fresh `claimed_at` inside `unclaimedGraceMs` territory: the peer is alive.
    await seedRun({
      id: "sqlite-held",
      owner: "peer:1:x",
      claimedAt: new Date().toISOString(),
    });

    expect(await harness.lease.claimRun("sqlite-held")).toBe(false);

    const row = await readRun("sqlite-held");
    expect(row.owner).toBe("peer:1:x");
  });
});

describe("heartbeatRun on better-sqlite3", () => {
  it("renews the lease by advancing claimed_at in the same millisecond-safe shape", async () => {
    await seedRun({ id: "sqlite-beat" });
    expect(await harness.lease.claimRun("sqlite-beat")).toBe(true);
    const first = (await readRun("sqlite-beat")).claimed_at as string;

    expect(await harness.lease.heartbeatRun("sqlite-beat")).toBe("alive");

    const second = (await readRun("sqlite-beat")).claimed_at as string;
    expect(second).toMatch(ISO);
    expect(new Date(second).getTime()).toBeGreaterThanOrEqual(
      new Date(first).getTime(),
    );
  });

  it("reports the lease as lost when a peer owns the row", async () => {
    await seedRun({
      id: "sqlite-lost",
      owner: "peer:1:x",
      claimedAt: new Date().toISOString(),
    });

    expect(await harness.lease.heartbeatRun("sqlite-lost")).toBe("lost");
  });
});

describe("checkpoints on better-sqlite3", () => {
  it("parses the snapshot back into an object rather than returning raw text", async () => {
    await seedRun({ id: "sqlite-ckpt" });
    expect(await harness.lease.claimRun("sqlite-ckpt")).toBe(true);

    const snapshot = { version: 1, phase: "collect", state: { round: 2 } };
    // `saveCheckpoint` returns `void` and reports refusal through the logger,
    // so the column is the only observable.
    await harness.checkpoints.saveCheckpoint({
      runId: "sqlite-ckpt",
      snapshot: snapshot,
    });

    const loaded = await harness.checkpoints.loadCheckpoint("sqlite-ckpt");
    // `toEqual` on an object fails against a JSON string, which is the exact
    // regression the `fromJson` call guards.
    expect(loaded).toEqual(snapshot);
    expect(typeof loaded).toBe("object");
  });

  it("keeps the column as text, which is why the parse above is required", async () => {
    await seedRun({ id: "sqlite-raw" });
    expect(await harness.lease.claimRun("sqlite-raw")).toBe(true);
    await harness.checkpoints.saveCheckpoint({
      runId: "sqlite-raw",
      snapshot: { version: 1, phase: "collect", state: {} },
    });

    const row = await readRun("sqlite-raw");
    expect(typeof row.checkpoint).toBe("string");
    expect(row.checkpoint).toBe(
      JSON.stringify({ version: 1, phase: "collect", state: {} }),
    );
  });

  it("refuses a checkpoint written by a replica that lost the lease", async () => {
    await seedRun({ id: "sqlite-zombie", owner: "peer:1:x" });

    await harness.checkpoints.saveCheckpoint({
      runId: "sqlite-zombie",
      snapshot: { version: 1, phase: "collect", state: {} },
    });

    // The write never happened, and the operator was told why.
    expect((await readRun("sqlite-zombie")).checkpoint).toBeNull();
    expect(libLog.warn).toHaveBeenCalledWith(
      { runId: "sqlite-zombie", owner: "peer:1:x" },
      "[runs] Checkpoint discarded: the lease is no longer ours",
    );
  });

  it("refuses finishRun from a zombie replica after another peer took over", async () => {
    await seedRun({ id: "sqlite-zombie-finish", owner: "peer:2:y" });

    expect(
      await harness.lease.finishRun({
        runId: "sqlite-zombie-finish",
        stopReason: "complete",
        partial: { stale: true },
      }),
    ).toBe(false);

    const row = await readRun("sqlite-zombie-finish");
    expect(row.status).toBe("running");
    expect(row.owner).toBe("peer:2:y");
    expect(row.partial).toBeNull();
  });

  it("reports a missing run instead of the lease message", async () => {
    await harness.checkpoints.saveCheckpoint({
      runId: "sqlite-nothing",
      snapshot: { version: 1, phase: "collect", state: {} },
    });

    expect(libLog.warn).toHaveBeenCalledWith(
      { runId: "sqlite-nothing" },
      "[runs] Checkpoint discarded: the run is gone",
    );
  });
});

describe("releaseRun on better-sqlite3", () => {
  it("clears the lease it owns", async () => {
    await seedRun({ id: "sqlite-release" });
    expect(await harness.lease.claimRun("sqlite-release")).toBe(true);

    await harness.lease.releaseRun("sqlite-release");

    const row = await readRun("sqlite-release");
    expect(row.owner).toBeNull();
    expect(row.claimed_at).toBeNull();
  });

  it("leaves a peer's lease alone", async () => {
    const claimTime = new Date().toISOString();
    await seedRun({
      id: "sqlite-peer-release",
      owner: "peer:1:x",
      claimedAt: claimTime,
    });

    await harness.lease.releaseRun("sqlite-peer-release");

    const row = await readRun("sqlite-peer-release");
    expect(row.owner).toBe("peer:1:x");
    expect(row.claimed_at).toBe(claimTime);
  });
});

describe("markStaleRunsInterrupted on better-sqlite3", () => {
  it("closes only the stale runs that have no checkpoint to resume from", async () => {
    const stale = longAgo();
    await seedRun({ id: "sweep-orphan", owner: "dead:1:x", claimedAt: stale });
    await seedRun({
      id: "sweep-resumable",
      owner: "dead:1:x",
      claimedAt: stale,
      checkpoint: { version: 1, phase: "collect", state: {} },
    });
    await seedRun({
      id: "sweep-live",
      owner: "peer:1:x",
      claimedAt: new Date().toISOString(),
    });

    // The `WHERE claimed_at < ?` bound is a string for the same reason the
    // `SET` is; a `Date` here would throw and the sweep would abort.
    expect(await harness.lease.markStaleRunsInterrupted()).toBe(1);

    const orphan = await readRun("sweep-orphan");
    expect(orphan.status).toBe("interrupted");
    expect(orphan.owner).toBeNull();
    expect(orphan.claimed_at).toBeNull();
    expect(orphan.error).toBe(
      "The process running this run stopped before it finished",
    );

    const resumable = await readRun("sweep-resumable");
    expect(resumable.status).toBe("running");
    expect(resumable.owner).toBe("dead:1:x");

    const live = await readRun("sweep-live");
    expect(live.status).toBe("running");
    expect(live.owner).toBe("peer:1:x");
  });

  it("is a no-op when every stale row carries a checkpoint", async () => {
    const stale = longAgo();
    await seedRun({
      id: "sweep-only-resumable",
      owner: "dead:1:x",
      claimedAt: stale,
      checkpoint: { version: 1, phase: "collect", state: {} },
    });

    expect(await harness.lease.markStaleRunsInterrupted()).toBe(0);
    expect((await readRun("sweep-only-resumable")).status).toBe("running");
  });
});
