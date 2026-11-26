---
title: Run System
description: Execute durable, crash-resilient, multi-replica agent turns and long workflows with SQLite/PostgreSQL leases, Redis Stream replay, and automatic recovery sweeps.
navigation:
  icon: i-lucide-activity
seo:
  title: Durable Run System & Leases — Riavzon AI
  description: "Architecture guide for @riavzon/ai Run System: detached execution, lease heartbeats, cross-replica SSE reattachment, checkpoints, and automatic recovery."
---

Browser tabs reload, mobile connections drop, and container orchestrators restart pods mid-generation. `@riavzon/ai` includes a production-ready **Run System** that decouples AI execution from individual HTTP connections:

- **Detached execution**: Chat turns (`createAgent({ conversation: { persist: true }, runs: { kind: "chat", registry: true } })`) and long workflows (`runWorkflow()`) continue executing even if the user closes the tab.
- **Cross-replica replay & reattach**: Every emitted SSE frame carries a monotonic stream ID cursor (`id: <ms>-<seq>`) mirrored into Redis Streams so reconnecting clients resume from the exact token they last received — even when routed to a different server replica.
- **Lease-based ownership**: A database lease (`runs` table) with periodic heartbeats guarantees at most one process executes a run at a time.
- **Automatic crash recovery**: If a worker process dies, a periodic sweeper marks stale leases interrupted and hands resumable runs to registered resumers (`registerRunResumer()`).

## Architecture overview

```text [Multi-Replica Run Flow]
HTTP Request ──► Replica A
                   ├─ Creates row in `runs` (status="running", owner=INSTANCE_ID)
                   ├─ Heartbeats `runs.claimed_at` every 15s (lease TTL = 60s)
                   ├─ Publishes frames to local RunRegistry + Redis Stream (`run:<runId>:events`)
                   └─ Writes checkpoints to `runs.checkpoint` between workflow stages

Client Reconnects ──► Replica B (with Last-Event-ID)
                   ├─ Local `getRun(runId)` hit? ──► `streamFromRun()`
                   └─ Owned by another replica?  ──► `streamFromStore()` (tails Redis Stream)

Worker Crash ──► Replica B Recovery Sweep
                   ├─ Finds stale/interrupted rows (`claimed_at < now - leaseTtlMs`)
                   ├─ Routes `(row.kind, row.input.name)` to `findRunResumer()`
                   └─ Atomically re-claims row via `claimRun()` & resumes from checkpoint
```

## Boot the Run System (`startRuns`)

Register your custom workflow resumers first, then call `startRuns()` **once per process** after `configuration()` completes. (Chat runs are intentionally never auto-resumed — see [Leases, Recovery & Retries](/runs/leases-and-recovery).)

```ts [src/boot.ts]
import {
  configuration,
  registerRunResumer,
  startRuns,
} from "@riavzon/ai";

// 1. Initialize database, Redis, and AI clients
await configuration({
  // ...db, redis, openAiConfig, embeddingConfig
});

// 2. Register all custom workflow resumers before starting recovery
registerRunResumer({
  kind: "workflow",
  name: "research",
  adopt: async (row) => {
    await adoptResearchRun(row);
  },
});

// 3. Reconcile stale runs left by previous processes and start the recovery sweeper
const stopRuns = startRuns();

// 4. Clean up timers cleanly on shutdown
process.on("SIGTERM", () => {
  stopRuns();
  process.exit(0);
});
```

::warning
Calling `startRuns()` before `configuration()` throws because database access is required to reconcile stale leases. Register all resumers *before* calling `startRuns()` so the first recovery tick sees every runner.
::

## Run statuses & kinds

| Status | Meaning | Eligible for automatic recovery? | Eligible for `retryRun()`? |
| --- | --- | --- | --- |
| `running` | Actively claimed by a live process (or awaiting stale-lease detection after crash). | Yes, once `claimed_at` expires past `leaseTtlMs`. | No (returns `already_running`). |
| `interrupted` | Worker stopped or transient error occurred while a checkpoint existed. | Yes, until `attempts >= maxResumeAttempts`. | Yes. |
| `finished` | Completed normally. | No. | No. |
| `aborted` | Cancelled by user (`requestAbort()` / `AbortSignal`). | No. | Yes (explicit user retry). |
| `failed` | Ended with a non-transient error or exhausted attempts. | No. | Yes (explicit user retry). |

Run kinds (`RunKind`) default to `"chat"` (used by `createAgent()` detached turns) and `"workflow"` (used by `runWorkflow()` and custom multi-stage pipelines), and can be extended via `declare module "@riavzon/ai" { interface RunKindRegistry { ... } }`. Because multiple workflows often share `kind: "workflow"`, each distinguishes itself with `name` (stored at `runs.input.name`).

## Explore the Run System

::card-group
  :::card
  ---
  icon: i-lucide-shield-check
  title: Leases, Recovery & Retries
  to: /runs/leases-and-recovery
  ---
  Manage SQL leases, cross-replica aborts (`requestAbort`), resumer registration (`registerRunResumer`), recovery sweeps, and user-initiated `retryRun()`.
  :::

  :::card
  ---
  icon: i-lucide-radio-tower
  title: Event Store & Reattachment
  to: /runs/event-store-and-reattach
  ---
  Use Redis Streams (`appendEvent`, `tailRun`, `streamFromStore`) and the in-process `RunRegistry` (`streamFromRun`, `workflowStreamWithRegistry`) for seamless SSE reconnection.
  :::

  :::card
  ---
  icon: i-lucide-save
  title: Checkpoints & Durable Workflows
  to: /runs/checkpoints-and-workflows
  ---
  Orchestrate resumable workflows with `runWorkflow()`, versioned checkpoint envelopes (`checkpoint`, `parseCheckpoint`, `restore`), and transient error classification.
  :::

  :::card
  ---
  icon: i-lucide-git-branch
  title: Registering a Workflow Runner
  to: /runs/registering-a-workflow-runner
  ---
  Full production walkthrough wiring `boot` → `registerRunResumer()` → shared `runWorkflow()` runner → launch, reattach, abort, and retry HTTP endpoints.
  :::
::
