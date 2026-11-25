import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type OpenAI from "openai";
import type { Kysely, Selectable } from "kysely";

import type { Database, RunKind, RunStatus } from "~/db/schema.js";
import { toJson } from "~/db/utils.js";
import type { RunResumer, ResumableRow } from "~/runs/types.js";
import {
  INTEGRATION_PG_URL,
  INTEGRATION_REDIS_URL,
} from "~~/test/integration.setup";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config";
import { libLog, libLogger } from "~~/test/test-utils/logger";
import {
  embeddingFake,
  installEmbeddingFake,
  offlineClient,
} from "~~/test/test-utils/streamLlm";

/**
 * Multi-replica recovery, replication and cancellation, end to end.
 *
 * This is the suite that exercises the library's most load-bearing claim: that
 * two processes sharing one Postgres and one Redis never run the same work
 * twice, never lose a run whose owner died, and can always stop each other.
 *
 * Everything is real. Postgres holds the lease, Redis holds the event log, and
 * two independent configuration instances stand in for two replicas — each with
 * its own module registry, its own `INSTANCE_ID`, and its own Kysely/pool. The
 * only thing that is faked is the provider transport, because a language model
 * is a network boundary and not something a compose file can host.
 *
 * A note on "two replicas" in one process: `INSTANCE_ID` is computed from the
 * hostname, the pid and a random suffix, so two `loadConfig()` calls produce two
 * genuinely distinct owners. That is exactly the collision the lease guards
 * against, so the race tests are honest rather than simulated.
 */

interface Models {
  lease: typeof import("~/models/runLease.js");
  runs: typeof import("~/models/runs.js");
  checkpoints: typeof import("~/models/runCheckpoint.js");
}

interface Runs {
  registry: typeof import("~/runs/runRegistry.js");
  store: typeof import("~/runs/eventStore/index.js");
  shared: typeof import("~/runs/eventStore/shared.js");
  recovery: typeof import("~/runs/runRecovery.js");
  resumers: typeof import("~/runs/resumerRegistry.js");
  retry: typeof import("~/runs/retryRun.js");
  streamFromStore: typeof import("~/runs/streamFromStore.js").streamFromStore;
  streamFromRun: typeof import("~/runs/streamFromRun.js").streamFromRun;
  boot: typeof import("~/runs/boot.js");
}

/** One replica: its own config module, database handle, pool and redis client. */
interface Replica {
  env: LoadedConfig;
  db: Kysely<Database>;
  models: Models;
  runs: Runs;
  /** Short label for assertions and log readability. */
  label: string;
}

const CONVERSATION_USER = "u-replica";

interface BootOverrides {
  /** Widen or narrow the orphan grace window, defaulting to closing at once. */
  unclaimedGraceMs?: number;
}

/**
 * Boots a replica pointed at the shared Postgres and Redis.
 *
 * `loadConfig` calls `vi.resetModules()`, so every replica gets a fresh copy of
 * every module — which is what makes `INSTANCE_ID`, the resumer registry and the
 * in-process run map independent per replica, exactly as they would be in two
 * processes.
 */
async function bootReplica(
  label: string,
  options: BootOverrides = {},
): Promise<Replica> {
  const client: OpenAI = offlineClient();
  installEmbeddingFake(client, embeddingFake(8));
  const env = await loadConfig({
    dialect: "pg",
    pgUrl: INTEGRATION_PG_URL,
    redisUrl: INTEGRATION_REDIS_URL,
    logger: libLogger,
    dimensions: 8,
    overrides: {
      // A short lease and sweep so the tests observe recovery instead of waiting
      // out production defaults. These are the same knobs an operator would set.
      runs: {
        leaseTtlMs: 5_000,
        heartbeatIntervalMs: 1_000,
        recovery: {
          sweepIntervalMs: 100,
          maxAdoptPerSweep: 10,
          // The cap must exceed the attempts the sweep itself writes, or a
          // poisoned row is closed on the very pass that would adopt it.
          maxResumeAttempts: 3,
          unclaimedGraceMs: options.unclaimedGraceMs ?? 0,
        },
        registry: { retainFinishedMs: 60_000 },
        // A block of `BLOCK_MS` parks the reader until it times out, and the
        // tail only re-checks liveness after a timeout. Lowering it keeps the
        // "reader on another replica" tests from waiting out the 15s default.
        eventStore: { blockMs: 1_000, replayBatch: 100, ttlSeconds: 60 },
      },
      embeddingConfig: {
        client,
        dimensions: 8,
        matchingModel: "test-matching",
        retrievalModel: "test-retrieval",
      },
    },
  });

  const db = env.mod.getDb();
  const models: Models = {
    lease: await import("~/models/runLease.js"),
    runs: await import("~/models/runs.js"),
    checkpoints: await import("~/models/runCheckpoint.js"),
  };
  const runs: Runs = {
    registry: await import("~/runs/runRegistry.js"),
    store: await import("~/runs/eventStore/index.js"),
    shared: await import("~/runs/eventStore/shared.js"),
    recovery: await import("~/runs/runRecovery.js"),
    resumers: await import("~/runs/resumerRegistry.js"),
    retry: await import("~/runs/retryRun.js"),
    streamFromStore: (await import("~/runs/streamFromStore.js")).streamFromStore,
    streamFromRun: (await import("~/runs/streamFromRun.js")).streamFromRun,
    boot: await import("~/runs/boot.js"),
  };
  return { env, db, models, runs, label };
}

/**
 * One shared database owner used only for fixtures and assertions.
 *
 * The replicas each hold their own pool; a test that needs to write a row or
 * read one back uses this so it is never ambiguous which pool a query ran on.
 */
let owner: Replica;
let replicas: Replica[] = [];

/** Run ids this suite created, so the event streams are cleaned up. */
const createdRunIds = new Set<string>();

async function newRun(args: {
  id: string;
  status?: RunStatus;
  kind?: RunKind;
  name?: string;
  owner?: string | null;
  claimedAt?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
  attempts?: number;
  checkpoint?: unknown;
  conversationId?: number | null;
}): Promise<void> {
  createdRunIds.add(args.id);
  await owner.db
    .insertInto("runs")
    .values({
      id: args.id,
      kind: args.kind ?? "workflow",
      query: "a query",
      status: args.status ?? "running",
      input: toJson(args.name === undefined ? null : { name: args.name }),
      user_id: CONVERSATION_USER,
      owner: args.owner ?? null,
      claimed_at: args.claimedAt ?? null,
      started_at: args.startedAt ?? new Date().toISOString(),
      finished_at: args.finishedAt ?? null,
      attempts: args.attempts ?? 0,
      checkpoint: toJson(args.checkpoint ?? null),
      conversation_id: args.conversationId ?? null,
    })
    .execute();
}

async function readRun(id: string): Promise<Selectable<Database["runs"]>> {
  return await owner.db
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

/** A timestamp far enough in the past to count as a dead lease. */
function longAgo(ms = 60_000): string {
  return new Date(Date.now() - ms).toISOString();
}

/** Waits for a condition, failing with `message` instead of hanging. */
async function eventually(
  check: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * A resumer that records what it was asked to adopt and then finishes the run.
 *
 * Deliberately does the real thing rather than asserting from a spy: it claims
 * the lease first (as every production resumer must), so a test can prove that
 * two replicas racing on the same row only do the work once.
 */
interface AdoptionRecord {
  runId: string;
  attempts: number;
  replica: string;
  claimed: boolean;
}

function makeResumer(
  replica: Replica,
  adoptions: AdoptionRecord[],
  options: {
    kind?: "workflow" | "chat";
    name?: string;
    /** Skip claiming, to simulate a resumer that forgot the guard. */
    skipClaim?: boolean;
    /** Throw instead of finishing, so the "attempt failed" path runs. */
    fail?: boolean;
  } = {},
): RunResumer {
  return {
    kind: options.kind ?? "workflow",
    name: options.name,
    adopt: async (row: ResumableRow) => {
      const claimed = options.skipClaim
        ? true
        : await replica.models.lease.claimRun(row.id);
      adoptions.push({
        runId: row.id,
        attempts: (row as { attempts: number }).attempts,
        replica: replica.label,
        claimed,
      });
      if (options.fail) throw new Error("adopt exploded");
      if (!claimed) return;
      await replica.models.lease.finishRun({
        runId: row.id,
        stopReason: "resumed",
      });
    },
  };
}

beforeEach(async () => {
  owner = await bootReplica("fixture");
  await owner.env.truncate();
});

afterEach(async () => {
  for (const id of createdRunIds) {
    await owner.runs.store.dropStream(id).catch(() => undefined);
  }
  createdRunIds.clear();
  for (const replica of replicas) {
    replica.runs.registry.clearRuns();
    await replica.env.cleanup();
  }
  replicas = [];
  await owner.env.cleanup();
});

describe("two replicas sharing one Postgres", () => {
  it("gives each replica a distinct instance id", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);

    expect(a.models.lease.INSTANCE_ID).not.toBe(b.models.lease.INSTANCE_ID);
    expect(a.models.lease.INSTANCE_ID).toContain(String(process.pid));
  });

  it("lets exactly one replica win a claim on the same row", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    await newRun({ id: "race-1" });

    const results = await Promise.all([
      a.models.lease.claimRun("race-1"),
      b.models.lease.claimRun("race-1"),
    ]);

    // Both racers hit the same conditional UPDATE; Postgres serialises them, so
    // one wins and the other sees no row. Both true would mean duplicate work.
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await readRun("race-1");
    const winner = results[0] ? a : b;
    expect(row.owner).toBe(winner.models.lease.INSTANCE_ID);
  });

  it("refuses a second claim while the first lease is fresh", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    await newRun({ id: "fresh-1" });

    expect(await a.models.lease.claimRun("fresh-1")).toBe(true);
    expect(await b.models.lease.claimRun("fresh-1")).toBe(false);
  });

  it("lets the other replica take over once the lease goes stale", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    await newRun({
      id: "stale-1",
      owner: "A-dead:1:xxx",
      claimedAt: longAgo(),
    });

    expect(await b.models.lease.claimRun("stale-1")).toBe(true);
    const row = await readRun("stale-1");
    expect(row.owner).toBe(b.models.lease.INSTANCE_ID);
    // A steal is a resume, so the attempt counter moves exactly once.
    expect(row.attempts).toBe(1);
  });
});

describe("cross-replica cancellation", () => {
  it("tells the owner to stop when another replica writes abort", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    await newRun({ id: "abort-1" });
    await a.models.lease.claimRun("abort-1");

    // Replica B receives the user's stop request; it cannot reach A's
    // AbortController, so it writes the row instead.
    expect(await b.models.lease.requestAbort("abort-1")).toBe(true);

    // Replica A finds out on its next heartbeat.
    expect(await a.models.lease.heartbeatRun("abort-1")).toBe("aborted");
    const row = await readRun("abort-1");
    expect(row.status).toBe("aborted");
    // The lease is deliberately left intact so the owner can unwind.
    expect(row.owner).toBe(a.models.lease.INSTANCE_ID);
  });

  it("reports the abort to the winning replica exactly once", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    await newRun({ id: "abort-2" });
    await a.models.lease.claimRun("abort-2");

    const first = await b.models.lease.requestAbort("abort-2");
    const second = await b.models.lease.requestAbort("abort-2");

    expect([first, second]).toEqual([true, false]);
  });

  it("stops a live heartbeat loop when the row is aborted elsewhere", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    await newRun({ id: "abort-3" });
    await a.models.lease.claimRun("abort-3");
    const states: string[] = [];

    const stop = a.models.lease.startLeaseHeartbeat(
      "abort-3",
      (state) => {
        states.push(state);
      },
      { warn: vi.fn(), debug: vi.fn() },
    );

    await owner.db
      .updateTable("runs")
      .set({ status: "aborted" })
      .where("id", "=", "abort-3")
      .execute();

    await eventually(
      () => states.length > 0,
      "the heartbeat to report the abort",
    );
    expect(states).toEqual(["aborted"]);
    stop();
  });

  it("reports a lost lease when another replica takes the run over", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    await newRun({
      id: "lost-1",
      owner: a.models.lease.INSTANCE_ID,
      claimedAt: longAgo(),
    });

    expect(await b.models.lease.claimRun("lost-1")).toBe(true);
    expect(await a.models.lease.heartbeatRun("lost-1")).toBe("lost");
  });

  it("refuses to finish a run the user already aborted", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    await newRun({ id: "abort-race-1" });
    await a.models.lease.claimRun("abort-race-1");
    await a.models.lease.requestAbort("abort-race-1");

    // The stop request lands in the window between the loop returning and the
    // finish write. The finish must lose, or the user is told it succeeded.
    expect(await a.models.lease.finishRun({ runId: "abort-race-1" })).toBe(
      false,
    );
    expect((await readRun("abort-race-1")).status).toBe("aborted");
  });

  it("refuses finishRun from a zombie replica after another replica claimed the lease", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    await newRun({
      id: "zombie-finish-1",
      owner: a.models.lease.INSTANCE_ID,
      claimedAt: longAgo(),
    });

    expect(await b.models.lease.claimRun("zombie-finish-1")).toBe(true);
    expect(
      await a.models.lease.finishRun({
        runId: "zombie-finish-1",
        stopReason: "stale",
        partial: { from: "zombie" },
      }),
    ).toBe(false);

    const row = await readRun("zombie-finish-1");
    expect(row.status).toBe("running");
    expect(row.owner).toBe(b.models.lease.INSTANCE_ID);
    expect(row.stop_reason).toBeNull();
    expect(row.partial).toBeNull();
  });
});

describe("recovery sweeper adopting abandoned work", () => {
  it("adopts a run whose owner died and finishes it", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    const adoptions: AdoptionRecord[] = [];
    a.runs.resumers.registerRunResumer(makeResumer(a, adoptions));
    await newRun({
      id: "recover-1",
      owner: "dead-host:1:xxx",
      claimedAt: longAgo(),
    });

    const stop = a.runs.recovery.startRunRecovery();
    await eventually(
      async () => (await readRun("recover-1")).status === "finished",
      "the sweep to adopt and finish the run",
    );
    stop();

    expect(adoptions).toHaveLength(1);
    expect(adoptions[0]).toMatchObject({ runId: "recover-1", replica: "A" });
    const row = await readRun("recover-1");
    expect(row.stop_reason).toBe("resumed");
    // `finishRun` records the outcome but leaves the lease alone; the owner is
    // only cleared on an explicit release or by the reconciliation pass.
    expect(row.owner).toBe(a.models.lease.INSTANCE_ID);
  });

  it("has exactly one of two replicas do the work", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    const adoptions: AdoptionRecord[] = [];
    a.runs.resumers.registerRunResumer(makeResumer(a, adoptions));
    b.runs.resumers.registerRunResumer(makeResumer(b, adoptions));
    await newRun({
      id: "recover-race-1",
      owner: "dead-host:1:xxx",
      claimedAt: longAgo(),
    });

    const stopA = a.runs.recovery.startRunRecovery();
    const stopB = b.runs.recovery.startRunRecovery();
    await eventually(
      async () => (await readRun("recover-race-1")).status === "finished",
      "one replica to finish the run",
    );
    stopA();
    stopB();

    // Both replicas may *see* the candidate, but only the one that wins the
    // conditional claim may do the work. That is the duplicate-execution guard.
    const claimed = adoptions.filter((entry) => entry.claimed);
    expect(claimed).toHaveLength(1);
  });

  it("leaves a live run alone", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    const adoptions: AdoptionRecord[] = [];
    a.runs.resumers.registerRunResumer(makeResumer(a, adoptions));
    await newRun({
      id: "live-1",
      owner: a.models.lease.INSTANCE_ID,
      claimedAt: new Date().toISOString(),
    });

    const stop = a.runs.recovery.startRunRecovery();
    await new Promise((resolve) => setTimeout(resolve, 600));
    stop();

    expect(adoptions).toEqual([]);
    expect((await readRun("live-1")).status).toBe("running");
  });

  it("resumes an interrupted row that carries a checkpoint", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    const adoptions: AdoptionRecord[] = [];
    a.runs.resumers.registerRunResumer(makeResumer(a, adoptions));
    await newRun({
      id: "interrupted-1",
      status: "interrupted",
      finishedAt: longAgo(),
      checkpoint: { version: 1, phase: "collect", state: { round: 2 } },
    });

    const stop = a.runs.recovery.startRunRecovery();
    await eventually(
      async () => (await readRun("interrupted-1")).status === "finished",
      "the sweep to adopt the interrupted run",
    );
    stop();

    expect(adoptions).toHaveLength(1);
  });

  it("gives up on a run that keeps dying", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    const adoptions: AdoptionRecord[] = [];
    a.runs.resumers.registerRunResumer(makeResumer(a, adoptions));
    // attempts already at the cap, and still stale, so the sweep must close it.
    await newRun({
      id: "poison-1",
      owner: "dead-host:1:xxx",
      claimedAt: longAgo(),
      attempts: 3,
    });

    const stop = a.runs.recovery.startRunRecovery();
    await eventually(
      async () => (await readRun("poison-1")).status === "failed",
      "the sweep to give up on the run",
    );
    stop();

    const row = await readRun("poison-1");
    expect(row.error).toBe("Run abandoned after repeated resume attempts");
    expect(adoptions).toEqual([]);
  });

  it("closes a run no build can resume", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    // A resumer registered for a *different* name. `findRunResumer` only falls
    // back to an unnamed resumer, so a named row cannot borrow this one — which
    // is exactly the situation of a build that no longer ships the workflow.
    a.runs.resumers.registerRunResumer(
      makeResumer(a, [], { name: "a-shipped-workflow" }),
    );
    await newRun({
      id: "orphan-1",
      name: "a-retired-workflow",
      owner: "dead-host:1:xxx",
      claimedAt: longAgo(),
    });

    const stop = a.runs.recovery.startRunRecovery();
    await eventually(
      async () => (await readRun("orphan-1")).status === "failed",
      "the sweep to close the orphan",
    );
    stop();

    expect((await readRun("orphan-1")).error).toBe(
      'No runner is registered for workflow name "a-retired-workflow"',
    );
  });

  it("honours the unclaimed grace period before closing an orphan", async () => {
    // A wide grace window is how a rolling deploy is tolerated: a row whose
    // runner has not shipped yet is left alone instead of being written off.
    const a = await bootReplica("A", { unclaimedGraceMs: 600_000 });
    replicas.push(a);
    const adoptions: AdoptionRecord[] = [];
    // Named, so `a-pending-workflow` genuinely has no runner to hand it to.
    a.runs.resumers.registerRunResumer(
      makeResumer(a, adoptions, { name: "a-shipped-workflow" }),
    );
    await newRun({
      id: "grace-1",
      name: "a-pending-workflow",
      owner: "dead-host:1:xxx",
      claimedAt: longAgo(),
    });

    const stop = a.runs.recovery.startRunRecovery();
    await new Promise((resolve) => setTimeout(resolve, 500));
    stop();

    expect((await readRun("grace-1")).status).toBe("running");
    expect(libLog.debug).toHaveBeenCalledWith(
      {
        runId: "grace-1",
        kind: "workflow",
        name: "a-pending-workflow",
        ageMs: expect.any(Number) as number,
      },
      "[runs] No resumer for this row yet; leaving it for a pending rollout",
    );
  });

  it("skips the sweep entirely when nothing is registered", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    await newRun({
      id: "unregistered-1",
      owner: "dead-host:1:xxx",
      claimedAt: longAgo(),
    });

    const stop = a.runs.recovery.startRunRecovery();
    await new Promise((resolve) => setTimeout(resolve, 400));
    stop();

    // No resumer means no reason to poll, so the row is untouched.
    expect((await readRun("unregistered-1")).status).toBe("running");
    expect(libLog.debug).toHaveBeenCalledWith(
      "[runs] No run resumers registered; skipping sweep",
    );
  });

  it("keeps sweeping after a resumer throws", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    const adoptions: AdoptionRecord[] = [];
    a.runs.resumers.registerRunResumer(
      makeResumer(a, adoptions, { fail: true }),
    );
    await newRun({
      id: "throws-1",
      owner: "dead-host:1:xxx",
      claimedAt: longAgo(),
    });

    const stop = a.runs.recovery.startRunRecovery();
    await eventually(
      () => adoptions.length > 0,
      "the failing resumer to be invoked",
    );
    stop();

    expect(libLog.error).toHaveBeenCalledWith(
      { err: expect.anything(), runId: "throws-1" },
      "[runs] Resume attempt failed",
    );
  });
});

describe("manual retry", () => {
  it("reopens an aborted run and reports that it resumed from a checkpoint", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    const adoptions: AdoptionRecord[] = [];
    a.runs.resumers.registerRunResumer(makeResumer(a, adoptions));
    await newRun({
      id: "retry-1",
      status: "aborted",
      checkpoint: { version: 1, phase: "collect", state: {} },
    });

    const outcome = await a.runs.retry.retryRun("retry-1");

    expect(outcome).toEqual({
      ok: true,
      runId: "retry-1",
      kind: "workflow",
      name: null,
      resumed: true,
      attempts: 1,
    });
    await eventually(
      async () => (await readRun("retry-1")).status === "finished",
      "the retried run to finish",
    );
    expect(adoptions).toHaveLength(1);
  });

  it("reports resumed false when there is no checkpoint", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    a.runs.resumers.registerRunResumer(makeResumer(a, []));
    await newRun({ id: "retry-2", status: "failed" });

    const outcome = await a.runs.retry.retryRun("retry-2");

    expect(outcome).toMatchObject({ ok: true, resumed: false, attempts: 1 });
  });

  it("reports not_found for an unknown id", async () => {
    const a = await bootReplica("A");
    replicas.push(a);

    expect(await a.runs.retry.retryRun("nope")).toEqual({
      ok: false,
      reason: "not_found",
      message: "No run with id nope",
    });
  });

  it("reports no_runner with the name in the message", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    await newRun({ id: "retry-3", status: "failed", name: "gone" });

    expect(await a.runs.retry.retryRun("retry-3")).toMatchObject({
      ok: false,
      reason: "no_runner",
      message: 'No runner is registered for kind "workflow" name "gone"',
    });
  });

  it("refuses a run the sweep still owns", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    a.runs.resumers.registerRunResumer(makeResumer(a, []));
    await newRun({
      id: "retry-4",
      status: "running",
      owner: "dead-host:1:xxx",
      claimedAt: longAgo(),
    });

    expect(await a.runs.retry.retryRun("retry-4")).toMatchObject({
      ok: false,
      reason: "already_running",
      message:
        "The run is still marked running; the recovery sweep owns stale rows and will resume it",
    });
  });

  it("refuses a run executing on this replica", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    a.runs.resumers.registerRunResumer(makeResumer(a, []));
    await newRun({ id: "retry-5", status: "running" });
    a.runs.registry.registerRun({
      id: "retry-5",
      kind: "workflow",
      status: "running",
      startedAt: Date.now(),
    });

    expect(await a.runs.retry.retryRun("retry-5")).toMatchObject({
      ok: false,
      message: "The run is executing on this replica right now",
    });
  });

  it("refuses a run that has used every resume", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    a.runs.resumers.registerRunResumer(makeResumer(a, []));
    // The replica overrides cap resumes at 3, so 3 attempts is the ceiling.
    await newRun({ id: "retry-6", status: "failed", attempts: 3 });

    expect(await a.runs.retry.retryRun("retry-6")).toMatchObject({
      ok: false,
      reason: "attempts_exhausted",
      attempts: 3,
      message: `This run has already used all 3 resumes. Start a new run instead of retrying this one.`,
    });
  });

  it("reopens a failed run from its checkpoint", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    const adoptions: AdoptionRecord[] = [];
    a.runs.resumers.registerRunResumer(makeResumer(a, adoptions));
    await newRun({
      id: "retry-8",
      status: "failed",
      checkpoint: { version: 1, phase: "collect", state: { round: 4 } },
    });

    expect(await a.runs.retry.retryRun("retry-8")).toMatchObject({
      ok: true,
      resumed: true,
      attempts: 1,
    });
    await eventually(
      async () => (await readRun("retry-8")).status === "finished",
      "the resumer to finish the reopened run",
    );
  });

  it("reopens an aborted run and reports that no checkpoint was found", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    const adoptions: AdoptionRecord[] = [];
    a.runs.resumers.registerRunResumer(makeResumer(a, adoptions));
    await newRun({ id: "retry-7", status: "aborted" });

    // No checkpoint on the row, so the resume starts from the top and says so.
    expect(await a.runs.retry.retryRun("retry-7")).toEqual({
      ok: true,
      runId: "retry-7",
      kind: "workflow",
      name: null,
      resumed: false,
      attempts: 1,
    });
    expect(libLog.warn).toHaveBeenCalledWith(
      {
        runId: "retry-7",
        kind: "workflow",
        name: null,
        status: "aborted",
        attempts: 1,
        resumed: false,
      },
      "[runs] Retrying a run on request",
    );
    await eventually(
      async () => adoptions.length === 1,
      "the retry to hand the run to the resumer",
    );
    expect(adoptions[0]).toMatchObject({ runId: "retry-7", replica: "A" });
  });
});

describe("event replication through Redis", () => {
  it("lets a reader on another replica replay the whole run", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    createdRunIds.add("replicated-1");

    // Replica A publishes two events; the registry mirrors them into Redis.
    const handle = a.runs.registry.registerRun({
      id: "replicated-1",
      kind: "workflow",
      status: "running",
      startedAt: Date.now(),
    });
    a.runs.registry.publish(handle, { type: "chunk", text: "first" });
    a.runs.registry.publish(handle, { type: "chunk", text: "second" });

    // The store write is fire-and-forget; wait for it to land.
    await eventually(async () => {
      const page = await b.runs.store.readPage("replicated-1");
      return page.events.length >= 2;
    }, "both events to be readable on replica B");

    const page = await b.runs.store.readPage("replicated-1");
    expect(page.events).toEqual([
      { type: "chunk", text: "first" },
      { type: "chunk", text: "second" },
    ]);
    expect(page.ids).toHaveLength(2);
    expect(page.lastId).toBe(page.ids.at(-1));
  });

  it("resumes a cross-replica reader from the cursor it last saw", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    createdRunIds.add("replicated-2");

    const handle = a.runs.registry.registerRun({
      id: "replicated-2",
      kind: "workflow",
      status: "running",
      startedAt: Date.now(),
    });
    for (const text of ["one", "two", "three"]) {
      a.runs.registry.publish(handle, { type: "chunk", text });
    }

    await eventually(async () => {
      const page = await b.runs.store.readPage("replicated-2");
      return page.events.length >= 3;
    }, "three events to land in the stream");

    const first = await b.runs.store.readPage("replicated-2", "0-0", 2);
    expect(first.events).toEqual([
      { type: "chunk", text: "one" },
      { type: "chunk", text: "two" },
    ]);

    const cursor = first.ids.at(-1);
    if (cursor === undefined) throw new Error("the replicated page carried no ids");
    const rest = await b.runs.store.readPage("replicated-2", cursor);
    expect(rest.events).toEqual([{ type: "chunk", text: "three" }]);
  });

  it("streams a finished run to a reader on another replica", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    createdRunIds.add("replicated-3");

    const handle = a.runs.registry.registerRun({
      id: "replicated-3",
      kind: "workflow",
      status: "running",
      startedAt: Date.now(),
    });
    a.runs.registry.publish(handle, { type: "chunk", text: "hello" });
    a.runs.registry.publish(handle, { type: "done" });
    handle.status = "finished";

    await eventually(async () => {
      const page = await b.runs.store.readPage("replicated-3");
      return page.events.length >= 2;
    }, "the events to land in the stream");

    const body = await new Response(
      b.runs.streamFromStore({
        runId: "replicated-3",
        log: libLogger,
        heartbeatMs: 60_000,
        isRunAlive: () => Promise.resolve(false),
      }),
    ).text();

    expect(body).toContain("hello");
  });

  it("closes a store reader once the run is no longer alive", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    createdRunIds.add("replicated-4");
    await a.runs.store.appendEvent("replicated-4", "1-1", {
      type: "chunk",
      text: "only",
    });

    const response = new Response(
      a.runs.streamFromStore({
        runId: "replicated-4",
        log: libLogger,
        heartbeatMs: 60_000,
        isRunAlive: () => Promise.resolve(false),
      }),
    );

    // The liveness probe is only consulted after a blocked read times out, so
    // this resolves within one `blockMs` rather than never.
    const body = await response.text();

    expect(body).toContain("only");
    expect(body).toContain('"type":"done"');
    expect(libLog.debug).toHaveBeenCalledWith(
      { runId: "replicated-4", since: "0-0" },
      "[runs] Attached a reader through the event store",
    );
  }, 20_000);

  it("replays a local run to a subscriber that attaches late", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    const handle = a.runs.registry.registerRun({
      id: "local-replay-1",
      kind: "chat",
      status: "running",
      startedAt: Date.now(),
    });
    a.runs.registry.publish(handle, { type: "chunk", text: "before" });

    const bodyPromise = new Response(
      a.runs.streamFromRun({
        run: handle,
        log: libLogger,
        heartbeatMs: 60_000,
        conversationId: 42,
      }),
    ).text();

    // The init frame and the replayed event go out immediately; the done frame
    // closes the reader.
    await new Promise((resolve) => setTimeout(resolve, 50));
    a.runs.registry.publish(handle, { type: "done" });

    const body = await bodyPromise;
    expect(body).toContain("before");
    expect(body).toContain('"conversationId":42');
  });

  it("continues monotonic stream ids when a second replica adopts a run", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    createdRunIds.add("handoff-stream-1");

    // Replica A publishes two events and then dies mid-run.
    const handleA = a.runs.registry.registerRun({
      id: "handoff-stream-1",
      kind: "workflow",
      status: "running",
      startedAt: Date.now(),
    });
    a.runs.registry.publish(handleA, { type: "chunk", text: "a1" });
    a.runs.registry.publish(handleA, { type: "chunk", text: "a2" });

    await eventually(async () => {
      const page = await b.runs.store.readPage("handoff-stream-1");
      return page.events.length >= 2;
    }, "the dead replica's events to reach the stream");

    // B adopts the run. A production resumer seeds its handle from the store so
    // its first minted id lands *after* the dead replica's last one.
    const seededAfter = await b.runs.store.lastStreamId("handoff-stream-1");
    if (seededAfter === undefined) {
      throw new Error("the store reported no last stream id after two events");
    }
    const published = await b.runs.store.readPage("handoff-stream-1");
    // Two events were published, so the store ends on the second id — this is
    // the exact string Redis kept, not merely "something".
    expect(b.runs.shared.compareIds(seededAfter, published.ids[1] ?? "")).toBe(
      0,
    );
    const handleB = b.runs.registry.registerRun(
      {
        id: "handoff-stream-1",
        kind: "workflow",
        status: "running",
        startedAt: Date.now(),
      },
      seededAfter,
    );
    b.runs.registry.publish(handleB, { type: "chunk", text: "b1" });
    b.runs.registry.publish(handleB, { type: "chunk", text: "b2" });
    b.runs.registry.publish(handleB, { type: "done" });

    await eventually(async () => {
      const page = await b.runs.store.readPage("handoff-stream-1");
      return page.events.length >= 5;
    }, "the adopting replica's events to reach the stream");

    // Four events, in publish order: XADD rejected nothing and nothing was lost.
    const page = await b.runs.store.readPage("handoff-stream-1");
    expect(page.events).toEqual([
      { type: "chunk", text: "a1" },
      { type: "chunk", text: "a2" },
      { type: "chunk", text: "b1" },
      { type: "chunk", text: "b2" },
      { type: "done" },
    ]);

    // Ids are strictly increasing across the hand-off, so a reader paging
    // through them cannot skip or repeat.
    const shared = b.runs.shared;
    for (let i = 1; i < page.ids.length; i += 1) {
      expect(
        shared.compareIds(page.ids[i], page.ids[i - 1]),
      ).toBe(1);
    }

    // The second replica's ids come after the first replica's, which is the
    // property `seedAfterId` exists to guarantee.
    const boundary = page.ids[1];
    expect(shared.compareIds(page.ids[2], boundary)).toBe(1);
  });

  it("keeps ids monotonic even when the dead replica's clock ran ahead", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    createdRunIds.add("handoff-stream-2");

    const handleA = a.runs.registry.registerRun({
      id: "handoff-stream-2",
      kind: "workflow",
      status: "running",
      startedAt: Date.now(),
    });
    a.runs.registry.publish(handleA, { type: "chunk", text: "a1" });
    await eventually(async () => {
      const page = await b.runs.store.readPage("handoff-stream-2");
      return page.events.length >= 1;
    }, "the first event to land");

    // A machine whose clock is two seconds fast wrote an id the adopting
    // replica's `Date.now()` has not reached yet. A naive `nextId(Date.now())`
    // would reuse the same millisecond and `XADD` would reject the id, dropping
    // the event; seeding with `lastMintedId` makes the counter advance instead.
    const ahead = `${String(Date.now() + 2_000)}-0`;
    const future = a.runs.registry.registerRun(
      {
        id: "handoff-stream-2",
        kind: "workflow",
        status: "running",
        startedAt: Date.now(),
      },
      ahead,
    );
    a.runs.registry.publish(future, { type: "chunk", text: "a2" });
    await eventually(async () => {
      const page = await b.runs.store.readPage("handoff-stream-2");
      return page.events.length >= 2;
    }, "the ahead-of-clock event to land");

    // B adopts and seeds from the store, so it starts after the skewed id.
    const seededAfter = await b.runs.store.lastStreamId("handoff-stream-2");
    if (seededAfter === undefined) {
      throw new Error("the store reported no last id after the skewed publish");
    }
    // `a2` was numbered inside the skewed millisecond, so the store ends strictly
    // above the id we seeded with — nothing was rejected by Redis along the way.
    expect(b.runs.shared.compareIds(seededAfter, ahead)).toBe(1);
    const handleB = b.runs.registry.registerRun(
      {
        id: "handoff-stream-2",
        kind: "workflow",
        status: "running",
        startedAt: Date.now(),
      },
      seededAfter,
    );
    b.runs.registry.publish(handleB, { type: "chunk", text: "b1" });
    await eventually(async () => {
      const page = await b.runs.store.readPage("handoff-stream-2");
      return page.events.length >= 3;
    }, "the adopting replica's event to land");

    const page = await b.runs.store.readPage("handoff-stream-2");
    expect(page.events).toEqual([
      { type: "chunk", text: "a1" },
      { type: "chunk", text: "a2" },
      { type: "chunk", text: "b1" },
    ]);
    // Nothing was dropped, so the three events really did get three ids.
    expect(page.ids).toHaveLength(3);
    expect(b.runs.shared.compareIds(page.ids[2], ahead)).toBe(1);
  });
});

describe("lease heartbeat keeps a long run alive", () => {
  it("prevents a second replica from stealing a run that is still beating", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    await newRun({ id: "beat-1" });
    expect(await a.models.lease.claimRun("beat-1")).toBe(true);

    const ensureFresh = async (): Promise<void> => {
      const row = await readRun("beat-1");
      if (row.status !== "running") return;
      await a.db
        .updateTable("runs")
        .set({ claimed_at: new Date().toISOString() })
        .where("id", "=", "beat-1")
        .where("owner", "=", a.models.lease.INSTANCE_ID)
        .execute();
    };
    await ensureFresh();

    // With a fresh heartbeat the other replica must be refused.
    expect(await b.models.lease.claimRun("beat-1")).toBe(false);

    // Let the lease lapse and the steal succeeds, which is the whole point.
    await owner.db
      .updateTable("runs")
      .set({ claimed_at: longAgo() })
      .where("id", "=", "beat-1")
      .execute();
    expect(await b.models.lease.claimRun("beat-1")).toBe(true);
  });
});

describe("checkpoint survives a replica hand-off", () => {
  it("resumes from the snapshot the dead replica wrote", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    await newRun({ id: "handoff-1" });
    await a.models.lease.claimRun("handoff-1");

    // Replica A gets as far as round 2, then dies.
    await a.models.checkpoints.saveCheckpoint({
      runId: "handoff-1",
      snapshot: {
        version: 1,
        phase: "collect",
        roundsDone: 2,
        state: { urls: ["https://example.com"] },
      },
    });

    // Replica B takes over once the lease lapses, and sees A's snapshot.
    await owner.db
      .updateTable("runs")
      .set({ claimed_at: longAgo() })
      .where("id", "=", "handoff-1")
      .execute();
    expect(await b.models.lease.claimRun("handoff-1")).toBe(true);

    expect(await b.models.checkpoints.loadCheckpoint("handoff-1")).toEqual({
      version: 1,
      phase: "collect",
      roundsDone: 2,
      state: { urls: ["https://example.com"] },
    });
  });

  it("ignores a checkpoint the zombie replica tries to write after the hand-off", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    await newRun({ id: "handoff-2" });
    await a.models.lease.claimRun("handoff-2");
    await a.models.checkpoints.saveCheckpoint({
      runId: "handoff-2",
      snapshot: { version: 1, phase: "collect", state: { round: 1 } },
    });

    // B takes over...
    await owner.db
      .updateTable("runs")
      .set({ claimed_at: longAgo() })
      .where("id", "=", "handoff-2")
      .execute();
    expect(await b.models.lease.claimRun("handoff-2")).toBe(true);
    await b.models.checkpoints.saveCheckpoint({
      runId: "handoff-2",
      snapshot: { version: 1, phase: "collect", state: { round: 5 } },
    });

    // ...and A, unaware it is a zombie, tries to write a stale snapshot.
    await a.models.checkpoints.saveCheckpoint({
      runId: "handoff-2",
      snapshot: { version: 1, phase: "collect", state: { round: 2 } },
    });

    // B's snapshot wins, so the successor is never sent back in time.
    expect(await b.models.checkpoints.loadCheckpoint("handoff-2")).toEqual({
      version: 1,
      phase: "collect",
      state: { round: 5 },
    });
  });

  it("ignores releaseRun from the zombie replica after another replica took over", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    await newRun({ id: "handoff-3" });

    // A claims and starts working.
    expect(await a.models.lease.claimRun("handoff-3")).toBe(true);
    const leaseOnA = (await readRun("handoff-3")).claimed_at;

    // A's lease lapses while it is still alive but wedged, so B takes over.
    await owner.db
      .updateTable("runs")
      .set({ claimed_at: longAgo() })
      .where("id", "=", "handoff-3")
      .execute();
    expect(await b.models.lease.claimRun("handoff-3")).toBe(true);
    const leaseOnB = (await readRun("handoff-3")).claimed_at;

    // B is now the owner and its lease is fresh.
    const row = await readRun("handoff-3");
    expect(row.owner).toBe(b.models.lease.INSTANCE_ID);
    expect(new Date(row.claimed_at as Date).getTime()).toBeGreaterThan(
      new Date(leaseOnA as Date).getTime(),
    );

    // A finally unwinds its `finally` block and releases a run it no longer
    // owns. If the guard regressed, this would null out B's live lease and a
    // third sweep would start the run a second time.
    await a.models.lease.releaseRun("handoff-3");

    const after = await readRun("handoff-3");
    expect(after.owner).toBe(b.models.lease.INSTANCE_ID);
    expect(new Date(after.claimed_at as Date).getTime()).toBe(
      new Date(leaseOnB as Date).getTime(),
    );
  });

  it("does not let the zombie heartbeat steal the lease back", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);
    await newRun({ id: "handoff-4" });

    expect(await a.models.lease.claimRun("handoff-4")).toBe(true);
    await owner.db
      .updateTable("runs")
      .set({ claimed_at: longAgo() })
      .where("id", "=", "handoff-4")
      .execute();
    expect(await b.models.lease.claimRun("handoff-4")).toBe(true);
    const leaseOnB = (await readRun("handoff-4")).claimed_at;

    // A's heartbeat is scoped to `owner = $self`, so it must report the loss
    // rather than renew anything, and it must leave B's claim timestamp alone.
    expect(await a.models.lease.heartbeatRun("handoff-4")).toBe("lost");

    const after = await readRun("handoff-4");
    expect(after.owner).toBe(b.models.lease.INSTANCE_ID);
    expect(new Date(after.claimed_at as Date).getTime()).toBe(
      new Date(leaseOnB as Date).getTime(),
    );
    // Still B's to run, so a second adoption cannot happen.
    expect(await a.models.lease.claimRun("handoff-4")).toBe(false);
  });
});

describe("boot reconciliation", () => {
  it("closes stale runs with nothing to resume and logs the count", async () => {
    const a = await bootReplica("A");
    replicas.push(a);
    await newRun({
      id: "boot-1",
      owner: "dead-host:1:xxx",
      claimedAt: longAgo(),
    });
    await newRun({
      id: "boot-2",
      owner: "dead-host:1:xxx",
      claimedAt: longAgo(),
      checkpoint: { version: 1, phase: "collect", state: {} },
    });

    const stop = a.runs.boot.startRuns();
    await eventually(
      async () => (await readRun("boot-1")).status === "interrupted",
      "boot reconciliation to close the orphan",
    );
    stop();

    // The row with a checkpoint is left running on purpose: the sweep adopts it.
    expect((await readRun("boot-2")).status).toBe("running");
    expect(libLog.warn).toHaveBeenCalledWith(
      { count: 1, instance: a.models.lease.INSTANCE_ID },
      "[runs] Marked abandoned runs as interrupted",
    );
    expect(libLog.info).toHaveBeenCalledWith(
      { instance: a.models.lease.INSTANCE_ID, kinds: [] },
      "[runs] Recovery sweeper started",
    );
  });

  it("returns a stop function that is safe before the async boot finishes", async () => {
    const a = await bootReplica("A");
    replicas.push(a);

    const stop = a.runs.boot.startRuns();
    // Called synchronously, before reconciliation has completed.
    expect(() => {
      stop();
    }).not.toThrow();
  });

  it("leaves stale checkpointed runs and live peer runs untouched at boot", async () => {
    const a = await bootReplica("A");
    const b = await bootReplica("B");
    replicas.push(a, b);

    // 1. A stale `running` row that *does* carry a checkpoint. Reconciliation
    //    must not close it: the recovery sweep adopts it and continues from the
    //    snapshot, so closing it here would be the one-way door the checkpoint
    //    guard exists to prevent.
    await newRun({
      id: "boot-checkpointed",
      owner: "dead-host:1:xxx",
      claimedAt: longAgo(),
      checkpoint: { version: 1, phase: "collect", state: { round: 3 } },
    });

    // 2. A fresh `running` row owned by another live replica, which is exactly
    //    the shape of a rolling deploy: B booted first and is working.
    await newRun({
      id: "boot-live-peer",
      owner: b.models.lease.INSTANCE_ID,
      claimedAt: new Date().toISOString(),
    });

    // 3. A control: stale, no checkpoint, nobody's work. This one must close,
    //    which proves the sweep really ran rather than silently doing nothing.
    await newRun({
      id: "boot-orphan",
      owner: "dead-host:1:xxx",
      claimedAt: longAgo(),
    });

    const stop = a.runs.boot.startRuns();
    await eventually(
      async () => (await readRun("boot-orphan")).status === "interrupted",
      "boot reconciliation to close the checkpointless orphan",
    );
    stop();

    // The checkpointed row is still resumable...
    const checkpointed = await readRun("boot-checkpointed");
    expect(checkpointed.status).toBe("running");
    expect(checkpointed.owner).toBe("dead-host:1:xxx");
    expect(checkpointed.error).toBeNull();
    expect(await a.models.checkpoints.loadCheckpoint("boot-checkpointed")).toEqual(
      { version: 1, phase: "collect", state: { round: 3 } },
    );

    // ...and the live peer's row was never touched at all.
    const live = await readRun("boot-live-peer");
    expect(live.status).toBe("running");
    expect(live.owner).toBe(b.models.lease.INSTANCE_ID);
    expect(live.error).toBeNull();

    // Exactly one row was closed, so the count in the log is the honest one.
    expect(libLog.warn).toHaveBeenCalledWith(
      { count: 1, instance: a.models.lease.INSTANCE_ID },
      "[runs] Marked abandoned runs as interrupted",
    );
  });
});
