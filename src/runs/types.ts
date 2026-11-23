import type { findResumableRuns, KindOf } from "../models/runLease";
import type { Checkpoint } from "../types/Checkpoint";
import type { StoredRun } from "../types/RunModel";
import type { AgentEvent } from "../types/ToolExecutionTypes";
import type { WorkflowProgressUpdate } from "../agentic-loop/types";
import type { TraceCollector } from "../chat/traceCollector";
import { Logger } from "../config/configSchema";
import { SseFrame, StoredEvent } from "../types/Chat";

export type RunStatus = "running" | "finished" | "aborted" | "failed";

/** The `runs.kind` this module resumes. */
export type RunKind = KindOf;

/**
 * The envelope every long workflow returns to its route.
 *
 * `data` is the workflow's own answer (a research report, a product analysis, a
 * video plan, the three-part team output), so the envelope can be shared while
 * the payload stays typed. It lives beside the engine that produces it rather
 * than with the research request types it is no longer specific to.
 */
export interface WorkflowPayload<TData> {
  success: true;
  source: string;
  promptId?: number;
  generatedDocumentIds?: string[];
  isSufficient: boolean;
  stopReason: string;
  missingSearchTerms: string[];
  urls: string[];
  data: TData;
}

/**
 * Everything the shared lifecycle needs, independent of the work itself.
 *
 * `kind`/`name` are how the row is routed on resume: `name` is read back from
 * `runs.input.name` and matched against the registered resumers, so a workflow
 * must keep the same name across deploys or its old rows stop resuming.
 */
export interface WorkflowRunOptions<TProgress = WorkflowProgressUpdate> {
  kind: RunKind;
  /** Which registered workflow to run. Absent when the kind has one runner. */
  name?: string;
  query: string;
  userId?: string;
  conversationId?: number;
  /** Extra fields a resume needs to rebuild the loop config. */
  input?: Record<string, unknown>;
  signal?: AbortSignal;
  onRunStarted?: (runId: string) => void;
  /**
   * Use this id for a *new* run instead of generating one.
   *
   * The route needs it because it registers the run handle — and therefore the
   * `AbortController` a local stop button reaches — before calling in. Without
   * a supplied id the handle would have to be registered after the work had
   * already begun, which is exactly the window in which a stop request would be
   * lost.
   *
   * Ignored when `resumeRunId` is set, because a resumed run already has an id.
   */
  runId?: string;
  /**
   * Mirrors progress into the run registry so a client that dropped its
   * connection can reattach with `GET /api/runs/{id}/stream` and replay it.
   *
   * Optional because a resume from the recovery sweep has no client waiting and
   * nothing to replay to. When absent the run still executes identically; only
   * live reattachment is unavailable.
   */
  onProgress?: (event: TProgress) => void;
  resumeRunId?: string;
}

export interface RunHandle {
  id: string;
  kind: RunKind;
  conversationId?: number;
  status: RunStatus;
  startedAt: number;
  /** Append-only log of everything the loop emitted, for replay. */
  events: StoredEvent[];
  /**
   * The id of each entry in `events`, in the same order and same shrinking
   * window.
   *
   * Assigned by `publish` and reused by the event store, so one cursor works on
   * both copies: a client resumes with the last id it saw whether it lands on
   * this process or another replica. An array index could not do that — once
   * the log was trimmed the index silently pointed at a different event.
   */
  eventIds: string[];
  /**
   * The id the next append will be minted from.
   */
  lastMintedId?: string;
  /**
   * The stop button's only job. Calling `abort()` cancels the provider call
   * currently in flight and any subsequent one.
   */
  controller: AbortController;
  /**
   * Live readers. Each is handed the event and the id it was stored under, so a
   * frame written while the run is live carries the same cursor a replay would.
   */
  subscribers: Set<(event: StoredEvent, id: string) => void>;
  /** Cleared by the pump so a long-lived interval cannot leak. */
  disposal?: () => void;
}

/**
 * A handle as a caller supplies it.
 *
 * The log arrays, the subscriber set and the controller are owned by the
 * registry: it clears them, fans out into them and aborts through them. A
 * caller that had to write `events: []` would be describing bookkeeping it does
 * not control, so they are optional here and defaulted on registration.
 */
export type RunHandleInit = Omit<
  RunHandle,
  "events" | "eventIds" | "subscribers" | "controller"
> &
  Partial<Pick<RunHandle, "events" | "eventIds" | "subscribers" | "controller">>;

export interface PumpRunArgs {
  run: RunHandle;
  agent: AsyncIterable<AgentEvent>;
  trace: TraceCollector;
  log: { error: (obj: unknown, msg: string) => void };
  /** Called once, in `finally`, whatever the outcome. Must be idempotent. */
  persist: (status: TerminalStatus, error?: string) => Promise<void>;
}

/** The three ways a run can end. `running` is never reported by the pump. */
export type TerminalStatus = "finished" | "aborted" | "failed";

export interface StreamFromRunParams {
  run: RunHandle;
  /**
   * Stream id to resume after. `FIRST_ID` replays the whole run.
   *
   * The same unit `streamFromStore` takes, so a reconnecting client does not
   * have to know which replica answered it.
   */
  since?: string;
  /** `init` frame payload; only chat runs send one. */
  conversationId?: number;
  /** Sent on the `init` frame so the client can stop or reattach to this run. */
  runId?: string;
  log: Logger;
  heartbeatMs?: number;
}

export interface TailRunParams {
  runId: string;
  /** Stream id to start after. `FIRST_ID` replays the whole run. */
  afterId?: string;
  /** The id the event was stored under, so the reader can echo it to its client. */
  onEvent: (event: StoredEvent, id: string) => void;
  /** Polled before every event so a closed response stops the loop promptly. */
  shouldStop: () => boolean;
  /**
   * Called when the stream has gone quiet. The caller uses it to ask Postgres
   * whether the run actually ended, which is how a reader notices that the
   * replica holding the run died instead of waiting forever.
   */
  onIdle?: () => Promise<boolean>;
  /**
   * Called when the tail ends on a transport failure rather than a terminal
   * event, so the caller can close a response it would otherwise leave open.
   */
  onError?: (err: unknown) => void;
  log: Logger;
}

export interface StreamFromStoreParams {
  runId: string;
  /** Stream id to resume after. `FIRST_ID` replays from the beginning. */
  since?: string;
  conversationId?: number;
  log: Logger;
  heartbeatMs?: number;
  /**
   * Asked only when the stream goes quiet: is this run still running? Returning
   * `false` closes the response.
   *
   * This is what lets a reader on replica B survive replica A dying. Without
   * it, a reader attached to a stream that will never receive another event
   * waits forever, because silence from Redis is indistinguishable from a
   * thinking agent.
   */
  isRunAlive: () => Promise<boolean>;
}

/** A row shape the sweep passes to whichever resumer owns its `kind`. */
export type ResumableRow = Awaited<
  ReturnType<typeof findResumableRuns>
>[number];
/**
 * How a run of one `kind` is put back to work.
 *
 * The sweep deliberately knows nothing about research or workflows. Each kind
 * registers its own adopt function, so adding a detachable workflow is one
 * registration rather than a new branch in this file — and, more importantly,
 * a `kind` that has no registered resumer is never adopted at all, instead of
 * being handed to the research runner and resumed with the wrong semantics.
 */
export interface RunResumer {
  kind: RunKind;
  /**
   * Optional discriminator *within* a kind, read from `runs.input.name`.
   *
   * Omit it when a kind has exactly one runner, which is the case for
   * `research`. Generic workflows all share `kind: "workflow"`, so each one
   * supplies its own `name` and gets its own registration. That is what keeps
   * workflows from funnelling through a single dispatcher: adding one is a new
   * file plus one line in `runsBoot.ts`, and no shared file grows.
   */
  name?: string;
  /**
   * Re-enters the run. Must re-claim the row conditionally before doing any
   * work, and must not throw on a claim refusal — losing a race is normal.
   */
  adopt: (row: ResumableRow) => Promise<void>;
}

export type RetryFailureReason =
  "not_found" | "already_running" | "attempts_exhausted" | "no_runner";

export type RetryOutcome =
  | {
      ok: true;
      runId: string;
      kind: StoredRun["kind"];
      name: string | null;
      /** True when a checkpoint existed and the run continues instead of restarting. */
      resumed: boolean;
      /** How many resumes this run has now used, including this one. */
      attempts: number;
    }
  | {
      ok: false;
      reason: RetryFailureReason;
      message: string;
      status?: StoredRun["status"];
      attempts?: number;
    };

export interface DetachedWorkflowArgs {
  /** The id the run will use. Must be the same id passed to the workflow. */
  runId: string;
  kind: RunKind;
  conversationId?: number;
  /**
   * The id the store already holds for this run, when it is being resumed.
   */
  seedAfterId?: string;
  log: Logger;
}

export interface DetachedWorkflow {
  /** The registered handle. Its `controller` is what a local abort fires. */
  run: RunHandle;
  /**
   * Wraps a frame sink so every frame also reaches the registry.
   *
   * Frame *construction* stays in `runProgressFrames`; this only decides that
   * the frames are recorded too. Passing the wrapped sink into the runner means
   * the response and the replay are the same frames by construction, rather than
   * two hand-maintained copies that can drift apart.
   */
  tee: (emit: (frame: SseFrame) => void) => (frame: SseFrame) => void;
  /** Publishes the terminal frames and schedules disposal. */
  finish: (result: SseFrame) => void;
  /** Publishes a failure and schedules disposal. */
  fail: () => void;
}

export interface WorkflowStreamWithRegistryArgs {
  /** The id this run will use. */
  runId: string;
  kind: RunKind;
  conversationId?: number;
  log: Logger;
  heartbeatMs?: number;
  /**
   * The work. `emit` writes a progress frame to both the response and the
   * registry; `signal` aborts when someone presses stop on this replica.
   */
  execute: (helpers: {
    emit: (frame: SseFrame) => void;
    signal: AbortSignal;
  }) => Promise<SseFrame>;
  /** Logs the failure. The client always sees a generic message. */
  onError?: (err: unknown) => void;
}

/**
 * The run lifecycle shared by every long workflow in this service.
 *
 * `runResearch` used to *be* the lifecycle, with the research loop welded into
 * the middle. Product, video and agentic-team need the same lifecycle around a
 * different body, so the parts that only depend on `runs`/leases/checkpoints
 * live here and each domain supplies its own work through `execute`.
 *
 * What the caller must not reimplement, because getting it wrong is silent:
 *
 * - **The row exists before the work starts.** A run that fails immediately must
 *   still have something a client can read, abort and retry.
 * - **The lease is claimed and heartbeated.** Without it two replicas will
 *   happily spend money on the same query.
 * - **The terminal status is written even on a throw.** `aborted` is not
 *   `failed`, and a transient network error becomes `interrupted` only when a
 *   checkpoint actually exists to resume from.
 * - **Cleanup runs in `finally`.** A leaked heartbeat keeps a dead run looking
 *   alive until its lease expires.
 */
export interface WorkflowRunContext<TProgress = WorkflowProgressUpdate> {
  runId: string;
  /** Aborted by the lease heartbeat, so the loop stops spending. */
  leaseSignal: AbortSignal;
  /**
   * Saves a resume snapshot.
   *
   * Typed against the envelope only: `state` inside it is the workflow's and
   * never inspected here. `parseCheckpoint` is what validates it on the way in.
   */
  saveCheckpoint: (snapshot: Checkpoint) => void;
  /** The snapshot from a previous process, or `null` on a fresh run. */
  loadCheckpoint: () => Promise<Checkpoint | null>;
  /**
   * Publishes one progress frame.
   *
   * A no-op unless the caller supplied `options.onProgress`. Using it keeps the
   * "what is a progress event" decision in the workflow while the route decides
   * where those events go.
   */
  emitProgress: (event: TProgress) => void;
}

export interface WorkflowExecution<TData> {
  /** Terminal payload of a successful run. */
  data: TData;
  source: string;
  promptId?: number;
  generatedDocumentIds?: string[];
  isSufficient: boolean;
  stopReason: string;
  missingSearchTerms: string[];
  urls: string[];
}
