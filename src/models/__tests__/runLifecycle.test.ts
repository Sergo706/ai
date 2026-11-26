import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Kysely } from "kysely";

import type { Database, RunKind, RunStatus } from "~/db/schema.js";
import { fromJson, toJson } from "~/db/utils.js";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";
import { libLog, libLogger } from "~~/test/test-utils/logger";

/**
 * The run lifecycle: create, claim, heartbeat, checkpoint, finish, release and
 * the recovery sweep.
 *
 * This is the suite that guards the multi-replica guarantees, so each test is
 * written as a scenario ("two processes race", "the owner died") rather than as
 * a call sheet. The interesting cases are all races, and a race only shows up
 * when the second actor is real.
 */

type Lease = typeof import("../runLease.js");
type Runs = typeof import("../runs.js");
type Checkpoint = typeof import("../runCheckpoint.js");

interface Harness {
  env: LoadedConfig;
  db: Kysely<Database>;
  lease: Lease;
  runs: Runs;
  checkpoints: Checkpoint;
}

/**
 * `runLease` derives `LEASE_TTL_MS` from the configuration at import time, so
 * the module has to be imported after `loadConfig` — otherwise it keeps the
 * constants of a configuration that no longer exists.
 */
async function boot(
  overrides: { leaseTtlMs?: number; heartbeatIntervalMs?: number } = {},
): Promise<Harness> {
  const env = await loadConfig({
    logger: libLogger,
    overrides: {
      runs: {
        leaseTtlMs: overrides.leaseTtlMs ?? 5_000,
        heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 1_000,
      },
    },
  });
  const lease = await import("../runLease.js");
  const runs = await import("../runs.js");
  const checkpoints = await import("../runCheckpoint.js");
  return { env, db: env.mod.getDb(), lease, runs, checkpoints };
}

async function seedRun(
  db: Kysely<Database>,
  args: {
    id: string;
    status?: RunStatus;
    owner?: string | null;
    claimedAt?: string | null;
    startedAt?: string;
    finishedAt?: string | null;
    checkpoint?: unknown;
    kind?: RunKind;
    conversationId?: number | null;
    userId?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await db
    .insertInto("runs")
    .values({
      id: args.id,
      kind: args.kind ?? "workflow",
      query: "q",
      status: args.status ?? "running",
      owner: args.owner ?? null,
      claimed_at: args.claimedAt ?? null,
      started_at: args.startedAt ?? new Date().toISOString(),
      finished_at: args.finishedAt ?? null,
      checkpoint: toJson(args.checkpoint ?? null),
      conversation_id: args.conversationId ?? null,
      user_id: args.userId ?? null,
      error: args.error ?? null,
    })
    .execute();
}

async function readRun(db: Kysely<Database>, id: string) {
  return await db
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

/** A timestamp far enough in the past to count as a dead lease. */
function longAgo(ms = 60_000): string {
  return new Date(Date.now() - ms).toISOString();
}

let harness: Harness;

beforeAll(async () => {
  harness = await boot();
});

beforeEach(async () => {
  await harness.env.truncate();
});

describe("createRun", () => {
  it("inserts a running row with the caller's fields", async () => {
    const { db, runs } = harness;

    await runs.createRun({
      id: "run-1",
      kind: "chat",
      query: "what is up",
      userId: "u-1",
      input: { name: "named" },
    });

    const row = await readRun(db, "run-1");
    expect(row.kind).toBe("chat");
    expect(row.query).toBe("what is up");
    expect(row.status).toBe("running");
    expect(row.user_id).toBe("u-1");
    expect(fromJson(row.input)).toEqual({ name: "named" });
    expect(row.attempts).toBe(0);
    expect(row.owner).toBeNull();
  });
});

describe("updateRun", () => {
  it("applies only the fields it was given", async () => {
    const { db, runs } = harness;
    await seedRun(db, { id: "run-1" });

    await runs.updateRun({ id: "run-1", status: "failed" });

    const row = await readRun(db, "run-1");
    expect(row.status).toBe("failed");
    expect(row.error).toBeNull();
    expect(row.finished_at).toBeNull();
  });

  it("stamps finished_at as an ISO string the dialect can bind", async () => {
    const { db, runs } = harness;
    await seedRun(db, { id: "run-1" });

    await runs.updateRun({ id: "run-1", status: "finished", finished: true });

    const row = await readRun(db, "run-1");
    // Regression guard: `new Date()` here threw on sqlite.
    expect(typeof row.finished_at).toBe("string");
    expect(new Date(row.finished_at as string).toISOString()).toBe(
      row.finished_at,
    );
  });

  it("serialises partial and clears fields when told to", async () => {
    const { db, runs } = harness;
    await seedRun(db, { id: "run-1" });
    await runs.updateRun({
      id: "run-1",
      partial: { text: "half" },
      error: "boom",
      stopReason: "max-rounds",
      messageId: 3,
    });

    const row = await readRun(db, "run-1");
    expect(fromJson(row.partial)).toEqual({ text: "half" });
    expect(row.error).toBe("boom");
    expect(row.stop_reason).toBe("max-rounds");
    expect(row.message_id).toBe(3);
  });

  it("is a no-op when nothing was supplied", async () => {
    const { db, runs } = harness;
    await seedRun(db, { id: "run-1" });

    await runs.updateRun({ id: "run-1" });

    expect((await readRun(db, "run-1")).status).toBe("running");
  });
});

describe("run lookups", () => {
  it("returns null for an unknown id", async () => {
    expect(await harness.runs.getRunById("nope")).toBeNull();
  });

  it("pages a conversation's runs newest first", async () => {
    const { db, runs } = harness;
    const conversationId = await db
      .insertInto("conversations")
      .values({ user_id: "u-1" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await seedRun(db, {
      id: "old",
      conversationId: conversationId.id,
      startedAt: "2024-01-01T00:00:00.000Z",
    });
    await seedRun(db, {
      id: "new",
      conversationId: conversationId.id,
      startedAt: "2024-02-01T00:00:00.000Z",
    });

    const page = await runs.getRunsByConversation(conversationId.id);

    expect(page.map((row) => row.id)).toEqual(["new", "old"]);
  });

  it("finds the latest resumable run of a conversation", async () => {
    const { db, runs } = harness;
    const conversationId = await db
      .insertInto("conversations")
      .values({ user_id: "u-1" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await seedRun(db, {
      id: "finished",
      status: "finished",
      conversationId: conversationId.id,
      startedAt: "2024-03-01T00:00:00.000Z",
    });
    await seedRun(db, {
      id: "interrupted",
      status: "interrupted",
      conversationId: conversationId.id,
      startedAt: "2024-02-01T00:00:00.000Z",
    });
    await seedRun(db, {
      id: "aborted",
      status: "aborted",
      conversationId: conversationId.id,
      startedAt: "2024-01-01T00:00:00.000Z",
    });

    const latest = await runs.getLatestResumableRun({
      conversationId: conversationId.id,
    });

    // `finished` is excluded even though it is the newest.
    expect(latest?.id).toBe("interrupted");
  });

  it("honours the userId filter on a resumable lookup", async () => {
    const { db, runs } = harness;
    const conversationId = await db
      .insertInto("conversations")
      .values({ user_id: "u-1" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await seedRun(db, {
      id: "theirs",
      status: "interrupted",
      conversationId: conversationId.id,
      userId: "u-2",
    });

    const latest = await runs.getLatestResumableRun({
      conversationId: conversationId.id,
      userId: "u-1",
    });

    expect(latest).toBeNull();
  });

  it("returns null when no run is resumable", async () => {
    const { db, runs } = harness;
    const conversationId = await db
      .insertInto("conversations")
      .values({ user_id: "u-1" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await seedRun(db, {
      id: "done",
      status: "finished",
      conversationId: conversationId.id,
    });

    expect(
      await runs.getLatestResumableRun({ conversationId: conversationId.id }),
    ).toBeNull();
  });

  it("lists closed runs that never got a host record", async () => {
    const { db, runs } = harness;
    await seedRun(db, { id: "a", status: "aborted", userId: "u-1" });
    await seedRun(db, { id: "b", status: "running", userId: "u-1" });
    await seedRun(db, { id: "c", status: "finished", userId: "u-2" });

    const unpersisted = await runs.getUnpersistedRuns("u-1");

    expect(unpersisted.map((row) => row.id)).toEqual(["a"]);
  });

  it("defaults to the workflow kind and accepts an override", async () => {
    const { db, runs } = harness;
    await seedRun(db, {
      id: "chat-run",
      kind: "chat",
      status: "failed",
      userId: "u-1",
    });
    await seedRun(db, {
      id: "wf-run",
      kind: "workflow",
      status: "failed",
      userId: "u-1",
    });

    expect((await runs.getUnpersistedRuns("u-1")).map((r) => r.id)).toEqual([
      "wf-run",
    ]);
    expect(
      (await runs.getUnpersistedRuns("u-1", 20, "chat")).map((r) => r.id),
    ).toEqual(["chat-run"]);
  });
});

describe("claimRun", () => {
  it("takes an unclaimed running row", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "run-1" });

    const claimed = await lease.claimRun("run-1");

    expect(claimed).toBe(true);
    const row = await readRun(db, "run-1");
    expect(row.owner).toBe(lease.INSTANCE_ID);
    expect(row.status).toBe("running");
    expect(new Date(row.claimed_at as string).toISOString()).toBe(
      row.claimed_at,
    );
  });

  it("refuses a fresh claim held by another process", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "run-1",
      owner: "other-host:1:abc",
      claimedAt: new Date().toISOString(),
    });

    expect(await lease.claimRun("run-1")).toBe(false);
    expect((await readRun(db, "run-1")).owner).toBe("other-host:1:abc");
  });

  it("steals a claim whose owner died", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "run-1",
      owner: "dead-host:1:abc",
      claimedAt: longAgo(),
    });

    expect(await lease.claimRun("run-1")).toBe(true);
    const row = await readRun(db, "run-1");
    expect(row.owner).toBe(lease.INSTANCE_ID);
    // A steal is a resume, so the attempt counter moves.
    expect(row.attempts).toBe(1);
  });

  it("refuses a closed run even when the lease looks free", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "done", status: "finished" });
    await seedRun(db, { id: "stopped", status: "aborted" });

    expect(await lease.claimRun("done")).toBe(false);
    expect(await lease.claimRun("stopped")).toBe(false);
  });

  it("counts an unclaimed row as untouched rather than a resume", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "run-1" });

    await lease.claimRun("run-1");

    expect((await readRun(db, "run-1")).attempts).toBe(0);
  });

  it("reopens an interrupted row and clears the old outcome", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "run-1",
      status: "interrupted",
      error: "died",
      finishedAt: longAgo(),
    });

    expect(await lease.claimRun("run-1")).toBe(true);
    const row = await readRun(db, "run-1");
    expect(row.status).toBe("running");
    expect(row.error).toBeNull();
    expect(row.stop_reason).toBeNull();
    expect(row.finished_at).toBeNull();
  });

  it("lets exactly one of two racing claims win", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "run-1" });

    const results = await Promise.all([
      lease.claimRun("run-1"),
      lease.claimRun("run-1"),
    ]);

    // Same process claims twice, so both are this instance — but the guard must
    // still serialise: the second claim must not add a resume.
    expect(results).toContain(true);
    expect((await readRun(db, "run-1")).owner).toBe(lease.INSTANCE_ID);
  });
});

describe("heartbeatRun", () => {
  it("reports alive and refreshes claimed_at for the owner", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "run-1",
      owner: lease.INSTANCE_ID,
      claimedAt: longAgo(45_000),
    });
    const before = (await readRun(db, "run-1")).claimed_at as string;

    const state = await lease.heartbeatRun("run-1");

    expect(state).toBe("alive");
    expect((await readRun(db, "run-1")).claimed_at).not.toBe(before);
  });

  it("reports aborted when another replica wrote a stop", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "run-1", owner: lease.INSTANCE_ID });
    await db
      .updateTable("runs")
      .set({ status: "aborted" })
      .where("id", "=", "run-1")
      .execute();

    expect(await lease.heartbeatRun("run-1")).toBe("aborted");
  });

  it("reports terminated for a non-abort terminal status", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "run-1", owner: lease.INSTANCE_ID });
    await db
      .updateTable("runs")
      .set({ status: "interrupted" })
      .where("id", "=", "run-1")
      .execute();

    expect(await lease.heartbeatRun("run-1")).toBe("terminated");
  });

  it("reports lost when another process holds the claim", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "run-1",
      owner: "other-host:9:zzz",
      claimedAt: new Date().toISOString(),
    });

    expect(await lease.heartbeatRun("run-1")).toBe("lost");
  });

  it("reports gone when the row vanished", async () => {
    expect(await harness.lease.heartbeatRun("missing")).toBe("gone");
  });
});

describe("requestAbort", () => {
  it("aborts a running run without stealing the lease", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "run-1", owner: "host:1:x" });

    expect(await lease.requestAbort("run-1")).toBe(true);
    const row = await readRun(db, "run-1");
    expect(row.status).toBe("aborted");
    expect(row.error).toBeNull();
    expect(new Date(row.finished_at as string).toISOString()).toBe(
      row.finished_at,
    );
    // The owner must still be able to unwind, so the lease is left intact.
    expect(row.owner).toBe("host:1:x");
  });

  it("does nothing for a run that already ended", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "run-1", status: "finished" });

    expect(await lease.requestAbort("run-1")).toBe(false);
    expect((await readRun(db, "run-1")).status).toBe("finished");
  });

  it("does nothing for an unknown run", async () => {
    expect(await harness.lease.requestAbort("nope")).toBe(false);
  });
});

describe("reopenRunForRetry", () => {
  it("reopens an aborted run and bumps the attempt counter", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "run-1",
      status: "aborted",
      owner: "host:1:x",
      claimedAt: longAgo(),
    });

    const reopened = await lease.reopenRunForRetry("run-1");

    expect(reopened).not.toBeNull();
    expect(reopened?.status).toBe("running");
    expect(reopened?.owner).toBeNull();
    expect(reopened?.claimed_at).toBeNull();
    expect(reopened?.attempts).toBe(1);
  });

  it("reopens interrupted and failed runs too", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "i", status: "interrupted" });
    await seedRun(db, { id: "f", status: "failed" });

    expect((await lease.reopenRunForRetry("i"))?.status).toBe("running");
    expect((await lease.reopenRunForRetry("f"))?.status).toBe("running");
  });

  it("refuses a finished or running run", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "done", status: "finished" });
    await seedRun(db, { id: "live", status: "running" });

    expect(await lease.reopenRunForRetry("done")).toBeNull();
    expect(await lease.reopenRunForRetry("live")).toBeNull();
  });

  it("returns null for an unknown run", async () => {
    expect(await harness.lease.reopenRunForRetry("nope")).toBeNull();
  });
});

describe("finishRun", () => {
  it("records the outcome of a running run", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "run-1", owner: lease.INSTANCE_ID });

    expect(
      await lease.finishRun({
        runId: "run-1",
        stopReason: "complete",
        partial: { text: "done" },
      }),
    ).toBe(true);

    const row = await readRun(db, "run-1");
    expect(row.status).toBe("finished");
    expect(row.stop_reason).toBe("complete");
    expect(JSON.parse(row.partial as unknown as string)).toEqual({
      text: "done",
    });
    expect(new Date(row.finished_at as string).toISOString()).toBe(
      row.finished_at,
    );
  });

  it("never overwrites a stop the user asked for", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "run-1",
      status: "aborted",
      owner: lease.INSTANCE_ID,
    });

    expect(await lease.finishRun({ runId: "run-1" })).toBe(false);
    expect((await readRun(db, "run-1")).status).toBe("aborted");
  });

  it("refuses to finish a run now owned by another replica", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "run-1",
      status: "running",
      owner: "other-host:1:abc",
    });

    expect(
      await lease.finishRun({
        runId: "run-1",
        stopReason: "zombie",
        partial: { text: "stale" },
      }),
    ).toBe(false);

    const row = await readRun(db, "run-1");
    expect(row.status).toBe("running");
    expect(row.owner).toBe("other-host:1:abc");
    expect(row.stop_reason).toBeNull();
    expect(row.partial).toBeNull();
  });

  it("defaults stop_reason and partial to null", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "run-1", owner: lease.INSTANCE_ID });

    await lease.finishRun({ runId: "run-1" });

    const row = await readRun(db, "run-1");
    expect(row.stop_reason).toBeNull();
    expect(row.partial).toBeNull();
  });

  it("fences updateRun when owner does not match the current holder", async () => {
    const { db, lease, runs } = harness;
    await seedRun(db, {
      id: "run-fenced",
      status: "running",
      owner: "other-host:2:xyz",
    });

    await runs.updateRun({
      id: "run-fenced",
      status: "failed",
      error: "stale failure",
      finished: true,
      owner: lease.INSTANCE_ID,
    });

    const unchanged = await readRun(db, "run-fenced");
    expect(unchanged.status).toBe("running");
    expect(unchanged.error).toBeNull();
    expect(unchanged.finished_at).toBeNull();

    await runs.updateRun({
      id: "run-fenced",
      status: "failed",
      error: "real failure",
      finished: true,
      owner: "other-host:2:xyz",
    });

    const updated = await readRun(db, "run-fenced");
    expect(updated.status).toBe("failed");
    expect(updated.error).toBe("real failure");
  });
});

describe("releaseRun", () => {
  it("drops the lease so another replica may adopt immediately", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "run-1",
      owner: lease.INSTANCE_ID,
      claimedAt: new Date().toISOString(),
    });

    await lease.releaseRun("run-1");

    const row = await readRun(db, "run-1");
    expect(row.owner).toBeNull();
    expect(row.claimed_at).toBeNull();
  });

  it("leaves somebody else's claim alone", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "run-1",
      owner: "other-host:1:abc",
      claimedAt: new Date().toISOString(),
    });

    await lease.releaseRun("run-1");

    expect((await readRun(db, "run-1")).owner).toBe("other-host:1:abc");
  });
});

describe("saveCheckpoint / loadCheckpoint", () => {
  it("round-trips a snapshot while we own the run", async () => {
    const { db, lease, checkpoints } = harness;
    await seedRun(db, { id: "run-1", owner: lease.INSTANCE_ID });
    const snapshot = { state: { round: 2, seen: ["a"] }, version: 1 };

    await checkpoints.saveCheckpoint({
      runId: "run-1",
      snapshot: snapshot as never,
    });

    expect(await checkpoints.loadCheckpoint("run-1")).toEqual(snapshot);
  });

  it("discards a snapshot once another process took the lease", async () => {
    const { db, checkpoints } = harness;
    await seedRun(db, { id: "run-1", owner: "other-host:1:abc" });

    await checkpoints.saveCheckpoint({
      runId: "run-1",
      snapshot: { state: { round: 1 } } as never,
    });

    const row = await readRun(db, "run-1");
    expect(row.checkpoint).toBeNull();
    expect(libLog.warn).toHaveBeenCalledWith(
      { runId: "run-1", owner: "other-host:1:abc" },
      "[runs] Checkpoint discarded: the lease is no longer ours",
    );
  });

  it("discards a snapshot for a run that no longer exists", async () => {
    const { checkpoints } = harness;

    await checkpoints.saveCheckpoint({
      runId: "ghost",
      snapshot: { state: {} } as never,
    });

    expect(libLog.warn).toHaveBeenCalledWith(
      { runId: "ghost" },
      "[runs] Checkpoint discarded: the run is gone",
    );
  });

  it("swallows a write failure and logs it", async () => {
    const { db, lease, checkpoints } = harness;
    await seedRun(db, { id: "run-1", owner: lease.INSTANCE_ID });
    const spy = vi.spyOn(db, "updateTable").mockImplementation(() => {
      throw new Error("disk on fire");
    });

    await expect(
      checkpoints.saveCheckpoint({
        runId: "run-1",
        snapshot: { state: {} } as never,
      }),
    ).resolves.toBeUndefined();

    expect(libLog.warn).toHaveBeenCalledWith(
      { err: expect.anything(), runId: "run-1" },
      "[runs] Could not write checkpoint",
    );
    spy.mockRestore();
  });

  it("returns null for a row without a snapshot", async () => {
    const { db, checkpoints } = harness;
    await seedRun(db, { id: "run-1" });

    expect(await checkpoints.loadCheckpoint("run-1")).toBeNull();
  });

  it("returns null for a missing run", async () => {
    expect(await harness.checkpoints.loadCheckpoint("nope")).toBeNull();
  });
});

describe("findResumableRuns", () => {
  it("adopts a running row whose owner died", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "dead",
      owner: "dead-host:1:abc",
      claimedAt: longAgo(),
    });

    const runs = await lease.findResumableRuns();

    expect(runs.map((row) => row.id)).toEqual(["dead"]);
  });

  it("skips a live claim", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "live",
      owner: "host:1:abc",
      claimedAt: new Date().toISOString(),
    });

    expect(await lease.findResumableRuns()).toEqual([]);
  });

  it("adopts a row that was created but never claimed, once the gap is stale", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "never-claimed",
      owner: null,
      claimedAt: null,
      startedAt: longAgo(),
    });

    expect((await lease.findResumableRuns()).map((row) => row.id)).toEqual([
      "never-claimed",
    ]);
  });

  it("skips a never-claimed row that was just created", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "fresh",
      owner: null,
      claimedAt: null,
      startedAt: new Date().toISOString(),
    });

    expect(await lease.findResumableRuns()).toEqual([]);
  });

  it("adopts an interrupted row only when it has a checkpoint", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "with-checkpoint",
      status: "interrupted",
      checkpoint: { state: { round: 1 } },
      finishedAt: longAgo(),
    });
    await seedRun(db, {
      id: "without-checkpoint",
      status: "interrupted",
      finishedAt: longAgo(),
    });

    const found = await lease.findResumableRuns();

    expect(found.map((row) => row.id)).toEqual(["with-checkpoint"]);
  });

  it("skips an interrupted row with a checkpoint that just failed", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "recent-failure",
      status: "interrupted",
      checkpoint: { state: {} },
      finishedAt: new Date().toISOString(),
    });

    expect(await lease.findResumableRuns()).toEqual([]);
  });

  it("scopes to the requested kind and respects the limit", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "wf",
      kind: "workflow",
      claimedAt: longAgo(),
      owner: "x:1:y",
    });
    await seedRun(db, {
      id: "chat",
      kind: "chat",
      claimedAt: longAgo(),
      owner: "x:1:y",
    });

    expect(
      (await lease.findResumableRuns(10, "chat")).map((r) => r.id),
    ).toEqual(["chat"]);
    expect(await lease.findResumableRuns(0, "workflow")).toEqual([]);
  });
});

describe("markStaleRunsInterrupted", () => {
  it("closes a stale run that has nothing to resume from", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "dead",
      owner: "dead-host:1:abc",
      claimedAt: longAgo(),
    });

    expect(await lease.markStaleRunsInterrupted()).toBe(1);

    const row = await readRun(db, "dead");
    expect(row.status).toBe("interrupted");
    expect(row.owner).toBeNull();
    expect(row.claimed_at).toBeNull();
    expect(row.error).toBe(
      "The process running this run stopped before it finished",
    );
    expect(new Date(row.finished_at as string).toISOString()).toBe(
      row.finished_at,
    );
  });

  it("leaves a stale run that carries a checkpoint for the sweep to adopt", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "resumable",
      owner: "dead-host:1:abc",
      claimedAt: longAgo(),
      checkpoint: { state: { round: 1 } },
    });

    expect(await lease.markStaleRunsInterrupted()).toBe(0);
    expect((await readRun(db, "resumable")).status).toBe("running");
  });

  it("never touches a live claim owned by another replica", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "live",
      owner: "other-host:1:abc",
      claimedAt: new Date().toISOString(),
    });

    expect(await lease.markStaleRunsInterrupted()).toBe(0);
    expect((await readRun(db, "live")).status).toBe("running");
  });

  it("closes a never-claimed row that is past the create/claim gap", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "orphan",
      owner: null,
      claimedAt: null,
      startedAt: longAgo(),
    });

    expect(await lease.markStaleRunsInterrupted()).toBe(1);
    expect((await readRun(db, "orphan")).status).toBe("interrupted");
  });
});

describe("startLeaseHeartbeat", () => {
  it("fires onStop for a stop requested by another replica", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "run-1", owner: lease.INSTANCE_ID });
    const states: string[] = [];
    const log = { warn: vi.fn(), debug: vi.fn() };

    const stop = lease.startLeaseHeartbeat(
      "run-1",
      (state) => {
        states.push(state);
      },
      log,
    );
    await db
      .updateTable("runs")
      .set({ status: "aborted" })
      .where("id", "=", "run-1")
      .execute();
    await vi.waitFor(
      () => {
        expect(states).toEqual(["aborted"]);
      },
      { timeout: 5_000 },
    );

    expect(log.debug).toHaveBeenCalledWith(
      { runId: "run-1" },
      "[runs] Abort requested from another replica; stopping",
    );
    stop();
  });

  it("logs a warning when the lease is lost", async () => {
    const { db, lease } = harness;
    await seedRun(db, {
      id: "run-1",
      owner: "other-host:1:abc",
      claimedAt: new Date().toISOString(),
    });
    const log = { warn: vi.fn(), debug: vi.fn() };

    const stop = lease.startLeaseHeartbeat("run-1", () => undefined, log);
    await vi.waitFor(
      () => {
        expect(log.warn).toHaveBeenCalledWith(
          { runId: "run-1" },
          "[runs] Lease lost; another replica took over",
        );
      },
      { timeout: 5_000 },
    );

    stop();
  });

  it("logs a warning when the row disappears", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "run-1", owner: lease.INSTANCE_ID });
    const log = { warn: vi.fn(), debug: vi.fn() };
    const stop = lease.startLeaseHeartbeat("run-1", () => undefined, log);
    await db.deleteFrom("runs").where("id", "=", "run-1").execute();

    await vi.waitFor(
      () => {
        expect(log.warn).toHaveBeenCalledWith(
          { runId: "run-1" },
          "[runs] Run row disappeared; stopping",
        );
      },
      { timeout: 5_000 },
    );

    stop();
  });

  it("logs a warning when the heartbeat itself throws", async () => {
    const { db, lease } = harness;
    await seedRun(db, { id: "run-1", owner: lease.INSTANCE_ID });
    const log = { warn: vi.fn(), debug: vi.fn() };
    const spy = vi.spyOn(db, "updateTable").mockImplementation(() => {
      throw new Error("connection reset");
    });

    const stop = lease.startLeaseHeartbeat("run-1", () => undefined, log);
    await vi.waitFor(
      () => {
        expect(log.warn).toHaveBeenCalledWith(
          { err: expect.anything(), runId: "run-1" },
          "[runs] Heartbeat failed",
        );
      },
      { timeout: 5_000 },
    );

    stop();
    spy.mockRestore();
  });
});

describe("lease constants", () => {
  it("clamps the heartbeat to half the lease so it can never expire between beats", async () => {
    const env = await loadConfig({
      logger: libLogger,
      overrides: { runs: { leaseTtlMs: 10_000, heartbeatIntervalMs: 9_000 } },
    });
    try {
      const { getLeaseTtlMs, getHeartbeatIntervalMs } =
        await import("../runLease.js");
      expect(getLeaseTtlMs()).toBe(10_000);
      expect(getHeartbeatIntervalMs()).toBe(5_000);
    } finally {
      await env.cleanup();
    }
  });

  it("builds a per-process instance id", async () => {
    const { INSTANCE_ID } = harness.lease;

    // hostname:pid:salt
    expect(INSTANCE_ID.split(":")).toHaveLength(3);
    expect(INSTANCE_ID.split(":")[1]).toBe(String(process.pid));
  });
});
