---
name: riavzon-ai-workflows-and-runs
description: Build multi-stage research/evidence workflows and crash-resilient, reattachable background runs with @riavzon/ai. Use when implementing AgenticWorkflowLoop, WorkflowAdapters, WorkflowBudgets, checkpoints, runWorkflow, registerRunResumer, startRuns, Redis Streams replay (streamFromRun/streamFromStore), workflowStreamWithRegistry, or cross-replica abort and lease recovery.
---

# Riavzon AI: Workflows & Durable Run System

Use this skill when building **bounded multi-stage evidence workflows** (`AgenticWorkflowLoop`) or **crash-resilient, reattachable, cross-replica runs** (`startRuns()`, `runWorkflow()`, `AgentConfig.runs`, Redis Streams replay) with `@riavzon/ai`.

For single-agent chat, tools, MCP, RAG ingestion, and basic SSE setup, pair this with the `riavzon-ai` skill.

## When to Use Which Primitive

| Use Case                                                                  | Primary Primitive                                                              | Durable Across Reload / Crash?                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Iterative local + external research with evaluator, critic, and synthesis | `AgenticWorkflowLoop`                                                          | Yes, when wrapped in `runWorkflow()` with `onCheckpoint` / `resumeFrom` |
| Long-lived agent chat that survives tab reloads and replica failover      | `createAgent({ runs: { ... } })` + `streamFromRun` / `streamFromStore`         | Yes (DB `runs` row + lease heartbeat + Redis Streams event log)         |
| Detached custom workflow exposed over SSE with replay & abort             | `workflowStreamWithRegistry()` or `attachDetachedWorkflow()` + `runWorkflow()` | Yes, when combined with `runWorkflow()` and `registerRunResumer()`      |
| One-shot workflow SSE without DB persistence or reattach                  | `workflowStream()`                                                             | No (ends on response close)                                             |

## Minimal Boot Sequence for Durable Runs

Every process hosting durable runs must execute this exact order at startup and clean up on shutdown:

```ts
import OpenAI from "openai";
import { Pool } from "pg";
import Redis from "ioredis";
import {
  configuration,
  registerRunResumer,
  startRuns,
  runWorkflow,
} from "@riavzon/ai";

// 1. Initialize @riavzon/ai with DB + Redis (Redis required for cross-replica replay)
await configuration({
  openAiConfig: new OpenAI({ apiKey: process.env.OPENAI_API_KEY! }),
  embeddingConfig: {
    dimensions: 1536,
    matchingModel: "text-embedding-3-small",
    retrievalModel: "text-embedding-3-small",
  },
  db: new Pool({ connectionString: process.env.DATABASE_URL! }),
  redis: new Redis(process.env.REDIS_URL!),
});

// 2. Register resumers BEFORE calling startRuns()
registerRunResumer({
  kind: "workflow",
  name: "market-research",
  adopt: async (row) => {
    await runWorkflow(
      {
        kind: "workflow",
        name: "market-research",
        query: row.query,
        userId: row.user_id ?? undefined,
        conversationId: row.conversation_id ?? undefined,
        resumeRunId: row.id,
      },
      async (ctx) => executeMarketResearch(row.query, ctx),
      logger,
    );
  },
});

// 3. Reconcile stale runs and start the background recovery sweeper
const stopRuns = startRuns();

// 4. Graceful shutdown
process.on("SIGTERM", () => {
  stopRuns();
});
```

## Five-Stage `AgenticWorkflowLoop` Pipeline

`AgenticWorkflowLoop` runs up to five strictly budgeted stages and guarantees termination (`stopReason`: `"sufficient" | "budget_exhausted" | "no_new_sources" | "aborted"`):

1. **`seeds`** — Executes caller-supplied `seedTargets` before discovery.
2. **`local`** — Pages through `localKnowledge.fetchBatch(offset, limit, state, ctx)` until sufficient, exhausted, or `maxConsecutiveInsufficientLocalBatches` is hit (skipped if `skipLocal: true` or `localKnowledge` omitted).
3. **`external`** — Calls `evaluator.evaluate(...)`, runs `externalDiscovery.discover(intent, ctx)` in parallel for `nextIntents`, and passes deduped targets to `targetExecutor.executeBatch(targets, state, ctx)`.
4. **`critic`** — Optional review (`critic.review(state, ctx)`); if rejected with `followUpIntents`, triggers bounded follow-up external rounds.
5. **`final`** — Optional synthesis (`finalAnswer.synthesize(result, ctx)`) producing strongly typed `result.report`.

### Generic `runWorkflow<TData, TMeta>` Envelope

`runWorkflow<TData, TMeta>(options, execute, log)` stores `runs` rows, maintains the lease heartbeat, saves checkpoints, classifies transient errors as `interrupted` (so `startRuns()` adopts them), and writes `RunPartial` (`report`, `isSufficient?`, `missingIntents?`, `meta?`):

- Keep workflow-specific metadata (URLs, generated document IDs, cost metrics) in the generic `meta?: TMeta` field rather than hardcoding domain keys.
- Unresolved intents live in `missingIntents?: string[]`.

## Run-Backed Agent Chat (`AgentConfig.runs`)

Enable `runs` on `createAgent()` to detach chat turns from individual HTTP sockets:

- Setting `runs` **always** registers a `RunHandle` in the in-process run registry (`registerRun` / `getRun`), creates a `runs` row, appends events to the Redis Streams event store (`appendEvent`), and schedules disposal after completion.
- **Run-backed semantic cache hits:** When `semanticCache` hits on a run-enabled agent, `@riavzon/ai` still creates a finished `runs` row, publishes `{ type: "chunk", text }` + `{ type: "done" }` into `RunHandle`, and schedules disposal (skipping lease heartbeats since it settles immediately). Clients receive both instant cached responses and a replayable `runId`.
- **Same-replica vs. cross-replica streaming:** Check `getRun(runId)` first; if present in local memory, serve `streamFromRun({ run, since, conversationId, runId, log })`. Otherwise serve `streamFromStore({ runId, since, conversationId, log, isRunAlive })`.
- **Cross-replica cancellation:** Call `requestAbort(runId)` (DB lease flag). The owning replica's lease heartbeat detects `"aborted"` and aborts `ctx.leaseSignal` / `run.controller`.

## Critical Rules & Constraints

1. **Always register resumers before `startRuns()`:** Unregistered `(kind, name)` pairs are intentionally skipped by the recovery sweep rather than routed to the wrong runner.
2. **Keep `RunResumer.name` exact:** Generic `"workflow"` runs match `runs.input.name`; single-runner kinds omit `name`.
3. **Never let `onCancel` abort a detached run:** In `framesToStream()` / SSE routes for detached runs, omit `onCancel` so a browser refresh or mobile sleep detaches the socket while the run keeps running. Use an explicit `POST /runs/:id/abort` endpoint calling `requestAbort(runId)` instead.
4. **Wrap checkpoints in the `checkpoint()` envelope:** `AgenticWorkflowLoop`'s `onCheckpoint` emits a `WorkflowCheckpoint` (`completedStages`, `localSearches`, `externalRounds`, `state`). Wrap it with `checkpoint({ phase: snapshot.completedStages.at(-1) ?? "seeds", state: snapshot, roundsDone: snapshot.externalRounds })` before calling `ctx.saveCheckpoint(...)`, and restore via `parseCheckpoint<WorkflowCheckpoint, WorkflowStage>(await ctx.loadCheckpoint(), { version: 1, phases: ["seeds", "local", "external", "critic", "final"] })?.state`.
5. **Tune `RUNS_*` env vars consistently across replicas:** Ensure lease TTL (`RUNS_LEASE_TTL_MS`) is comfortably larger than `RUNS_HEARTBEAT_INTERVAL_MS` (for example 30s lease, 5s heartbeat) so healthy replicas never lose ownership under GC pauses.

## Reference Guides

Load the detailed reference matching the task:

- **Workflow loop, 6 adapters, budgets, `WorkflowState` & checkpoints:** Read [references/workflow-adapters-and-checkpoints.md](references/workflow-adapters-and-checkpoints.md)
- **Durable run lifecycle, Redis Streams replay, reattach routes, `workflowStreamWithRegistry` & `RUNS_*` env vars:** Read [references/run-system-and-reattach.md](references/run-system-and-reattach.md)
