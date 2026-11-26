# Durable Run System, Redis Streams Replay & Reattach Routes

## Architecture Overview

A durable run has three cooperating layers:

1. **Database `runs` & `run_checkpoints` tables:** Durable status (`running | finished | aborted | failed | interrupted`), lease owner (`INSTANCE_ID`), `leaseExpiresAt`, `abortRequestedAt`, `input`, `partial` (`RunPartial`), and latest `WorkflowCheckpoint`.
2. **In-process `RunRegistry` (`RunHandle`):** Fast local subscriber fan-out, buffered event log, `AbortController`, and timed post-completion disposal (`scheduleDisposal`).
3. **Redis Streams `eventStore` (`appendEvent`, `readEvents`, `tailRun`):** Cross-replica ordered event log keyed by `runId` with stream IDs (`FIRST_ID = "0-0"`), enabling clients to reconnect via `Last-Event-ID` even when routed to a different replica.

## Connecting a Detached Workflow to SSE (`workflowStreamWithRegistry`)

Combine `workflowStreamWithRegistry()` with `runWorkflow()` so the initial HTTP request streams live events while keeping the run registered, replayable, and decoupled from socket disconnects:

```ts
import {
  workflowStreamWithRegistry,
  runWorkflow,
  SSE_HEADERS,
} from "@riavzon/ai";

export async function POST(req: Request) {
  const { query, userId } = await req.json();
  const runId = crypto.randomUUID();

  const stream = workflowStreamWithRegistry({
    runId,
    kind: "workflow",
    log: logger,
    heartbeatMs: 15_000,
    onError: (err) => logger.error({ err, runId }, "Workflow failed"),
    execute: async ({ emit, signal }) => {
      const payload = await runWorkflow<FinalReport, { urls: string[] }>(
        {
          kind: "workflow",
          name: "market-research",
          runId,
          query,
          userId,
          signal,
          onProgress: (ev) =>
            emit({
              type: "workflow_progress",
              runId,
              workflow: ev.workflow,
              stage: ev.stage,
              label: ev.label,
              addedEvidence: ev.addedEvidence,
              round: ev.round,
              intent: ev.intent,
              custom: ev.custom,
              callIndex: 0,
              callTotal: 0,
            }),
        },
        async (ctx) => {
          const result = await executeMarketResearch(query, ctx);
          return {
            data: result.report!,
            stopReason: result.stopReason,
            source: result.source,
            isSufficient: result.isSufficient,
            missingIntents: result.missingIntents,
            meta: { urls: result.externalArtifacts.map((a) => a.url) },
          };
        },
        logger,
      );

      // Return the final SseFrame pushed to both the response and RunRegistry
      return { type: "chunk", text: JSON.stringify(payload) };
    },
  });

  return new Response(stream, {
    headers: { ...SSE_HEADERS, "X-Run-Id": runId },
  });
}
```

## Reattach Route (`GET /api/runs/:id/stream`)

Handle both **same-replica** (in-memory `RunRegistry`) and **cross-replica** (Redis Streams `eventStore`) seamlessly using `Last-Event-ID` (defaulting to `FIRST_ID`):

```ts
import {
  getRun,
  getRunById,
  streamFromRun,
  streamFromStore,
  FIRST_ID,
  SSE_HEADERS,
} from "@riavzon/ai";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const runId = params.id;
  const since =
    req.headers.get("last-event-id") ??
    new URL(req.url).searchParams.get("since") ??
    FIRST_ID;

  // Fast path: run lives in this replica's memory
  const localRun = getRun(runId);
  if (localRun) {
    const stream = streamFromRun({
      run: localRun,
      since,
      runId,
      conversationId: localRun.conversationId,
      log: logger,
      heartbeatMs: 10_000,
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  // Cross-replica or completed-run replay path via Redis Streams
  const row = await getRunById(runId);
  if (!row) return new Response("Run not found", { status: 404 });

  const stream = streamFromStore({
    runId,
    since,
    conversationId: row.conversationId ?? undefined,
    log: logger,
    heartbeatMs: 10_000,
    isRunAlive: async () => {
      const latest = await getRunById(runId);
      return latest?.status === "running";
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
```

## Cross-Replica Abort & Retry (`requestAbort`, `retryRun`)

```ts
import { getRun, requestAbort, retryRun } from "@riavzon/ai";

export async function abortHandler(runId: string) {
  // 1. Persist abort request in DB so whichever replica owns the lease stops
  const updated = await requestAbort(runId);
  // 2. Also abort immediately if owned by this replica
  getRun(runId)?.controller.abort();
  return Response.json({ aborted: updated });
}

export async function retryHandler(runId: string) {
  // Re-enters an interrupted/failed/aborted run via its registered RunResumer
  const outcome = await retryRun(runId);
  return Response.json(outcome, { status: outcome.ok ? 200 : 409 });
}
```

## Lease Recovery & `RUNS_*` Environment Variables

When a replica dies mid-run, its lease expires after `RUNS_LEASE_TTL_MS`. Any surviving replica running `startRuns()` marks stale runs `interrupted`, finds resumable rows, matches `(row.kind, row.input?.name)` against `registerRunResumer()`, claims the row atomically, and invokes `adopt(row)`.

| Environment Variable | Purpose |
| --- | --- |
| `RUNS_LEASE_TTL_MS` | Lease duration before a silent owner is considered dead (overriding `config.runs.leaseTtlMs`) |
| `RUNS_HEARTBEAT_INTERVAL_MS` | How often the owning replica renews its lease and checks for remote abort |
| `RUNS_SWEEP_INTERVAL_MS` | How often `startRuns()` sweeps for `interrupted` / expired runs |
| `RUNS_MAX_ADOPT_PER_SWEEP` | Maximum stale runs adopted per recovery sweep tick |
| `RUNS_MAX_RESUME_ATTEMPTS` | Maximum crash-recovery resume attempts before permanently failing a run |
| `RUNS_UNCLAIMED_GRACE_MS` | Grace window before an unclaimed `running` row is considered stale |
| `RUNS_RETAIN_FINISHED_MS` | How long completed `RunHandle`s remain cached in `RunRegistry` before disposal |
| `RUNS_STREAM_TTL_SECONDS` | Redis Streams TTL for stored run events |
| `RUNS_STREAM_MAX_LEN` | Maximum event cap trimmed per Redis Stream |
| `RUNS_STREAM_BLOCK_MS` | Redis `XREAD` block timeout for live `tailRun` readers |
| `RUNS_STREAM_REPLAY_BATCH` | Batch size read per Redis `XRANGE` replay call |

## Transient Error Classification

`runWorkflow()` classifies failures with `isTransientError()`:

- **Transient failure + checkpoint exists:** Marks run `interrupted` so the recovery sweeper adopts and resumes it automatically.
- **Abort (`runWasAborted`):** Marks run `aborted` and does not retry.
- **Non-transient failure (or no checkpoint):** Marks run `failed` and rethrows.
