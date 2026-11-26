import type { findResumableRuns, KindOf } from "../models/runLease";
import type { Checkpoint } from "../types/Checkpoint";
import type { StoredRun } from "../types/RunModel";
import type { AgentEvent } from "../types/ToolExecutionTypes";
import type { WorkflowProgressUpdate } from "../agentic-loop/types";
import type { TraceCollector } from "../chat/traceCollector";
import { Logger } from "../config/configSchema";
import { SseFrame, StoredEvent } from "../types/Chat";

/** Lifecycle state of a run. */
export type RunStatus = "running" | "finished" | "aborted" | "failed";

/** The `runs.kind` this module resumes. */
export type RunKind = KindOf;

/**
 * The envelope a long workflow returns to its route.
 *
 * Shared across workflows so each one can keep its own `data` and optional
 * `meta` types.
 */
export interface WorkflowPayload<TData, TMeta = unknown> {
  /** `true` when the run completed without throwing. */
  success: true;
  /** The workflow's own answer, typed by the caller. */
  data: TData;
  /** Why the run stopped. */
  stopReason: string;
  /** Where the evidence came from, e.g. `"local"` or `"mixed"`, when applicable. */
  source?: string;
  /** Whether the run gathered enough evidence to answer, when applicable. */
  isSufficient?: boolean;
  /** Intents the run never got to, when applicable. */
  missingIntents?: string[];
  /** Workflow-specific metadata (e.g. visited URLs, generated file IDs, metrics). */
  meta?: TMeta;
}

/**
 * Everything the shared run lifecycle needs, independent of the work itself.
 *
 * `kind`/`name` are how a row is routed on resume: `name` is read back from
 * `runs.input.name` and matched against the registered resumers, so a workflow
 * must keep the same name across deploys or its old rows stop resuming.
 */
export interface WorkflowRunOptions<TProgress = WorkflowProgressUpdate> {
  /** Which resume strategy this run belongs to. */
  kind: RunKind;
  /** Which registered workflow to run, when the kind has several. */
  name?: string;
  /** The question or task the run works on. */
  query: string;
  /** Owner of the run. */
  userId?: string;
  /** Conversation the run answers, for chat turns. */
  conversationId?: number;
  /** Extra fields a resume needs to rebuild the loop config. */
  input?: Record<string, unknown>;
  /** Cancels the run. */
  signal?: AbortSignal;
  /** Called once with the id this run was given. */
  onRunStarted?: (runId: string) => void;
  /**
   * Use this id for a new run instead of generating one.
   *
   * Lets the caller register the run handle, and therefore its stop button,
   * before the work starts. Ignored when `resumeRunId` is set.
   */
  runId?: string;
  /**
   * Mirror progress into the run registry, so a client that dropped can
   * reattach with `streamFromRun` and replay it.
   *
   * Omit it when nothing is listening, e.g. a recovery-sweep resume.
   */
  onProgress?: (event: TProgress) => void;
  /** Continue an existing run instead of starting a new one. */
  resumeRunId?: string;
}

/** A live run held in process memory. */
export interface RunHandle {
  /** The run id. */
  id: string;
  /** Which resume strategy this run belongs to. */
  kind: RunKind;
  /** Conversation the run answers, for chat turns. */
  conversationId?: number;
  /** Lifecycle state. */
  status: RunStatus;
  /** When the run started, in epoch milliseconds. */
  startedAt: number;
  /** Append-only log of everything the loop emitted, for replay. */
  events: StoredEvent[];
  /**
   * Cursor id of each entry in `events`, in the same order.
   *
   * A client resumes with the last id it saw, whether it lands on this process
   * or another replica.
   */
  eventIds: string[];
  /** The id the next append will be minted from. */
  lastMintedId?: string;
  /** Aborts the provider call in flight and any later one. */
  controller: AbortController;
  /**
   * Live readers.
   *
   * Each receives the event plus the id it was stored under, so a live frame
   * carries the same cursor a replay would.
   */
  subscribers: Set<(event: StoredEvent, id: string) => void>;
  /** Cleanup hook, set by the pump and called on disposal. */
  disposal?: () => void;
}

/**
 * A handle as a caller supplies it.
 *
 * The log arrays, subscriber set and controller are owned by the registry, so
 * they are optional here and filled in on registration.
 */
export type RunHandleInit = Omit<
  RunHandle,
  "events" | "eventIds" | "subscribers" | "controller"
> &
  Partial<Pick<RunHandle, "events" | "eventIds" | "subscribers" | "controller">>;

/** Arguments for `pumpRun`. */
export interface PumpRunArgs {
  /** The run to drive. */
  run: RunHandle;
  /** The agent's event stream. */
  agent: AsyncIterable<AgentEvent>;
  /** Collects the message trace alongside the events. */
  trace: TraceCollector;
  /** Logger for failures while draining the stream. */
  log: { error: (obj: unknown, msg: string) => void };
  /**
   * Called once in `finally`, whatever the outcome. Must be idempotent.
   *
   * @param status - How the run ended.
   * @param error - Failure message, when it failed.
   */
  persist: (status: TerminalStatus, error?: string) => Promise<void>;
}

/** The three ways a run can end. `running` is never reported by the pump. */
export type TerminalStatus = "finished" | "aborted" | "failed";

/** Arguments for `streamFromRun`. */
export interface StreamFromRunParams {
  /** The in-process run to stream. */
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
  /** Sent on the `init` frame so the client can stop or reattach. */
  runId?: string;
  /** Logger for tail failures. */
  log: Logger;
  /**
   * Milliseconds between keep-alive comments.
   *
   * @default 10000
   */
  heartbeatMs?: number;
}

/** Arguments for `tailRun`. */
export interface TailRunParams {
  /** The run whose event log to follow. */
  runId: string;
  /** Stream id to start after. `FIRST_ID` replays the whole run. */
  afterId?: string;
  /**
   * Called for each new event.
   *
   * @param event - The stored event.
   * @param id - The id it was stored under, so the reader can echo the cursor.
   */
  onEvent: (event: StoredEvent, id: string) => void;
  /** Polled before every event so a closed response stops the loop promptly. */
  shouldStop: () => boolean;
  /**
   * Asked when the stream goes quiet: is the run still running?
   *
   * Returning `false` ends the tail, which is how a reader notices that the
   * process holding the run died instead of waiting forever.
   */
  onIdle?: () => Promise<boolean>;
  /** Called when the tail ends on a transport failure, not a terminal event. */
  onError?: (err: unknown) => void;
  /** Logger for tail failures. */
  log: Logger;
}

/** Arguments for `streamFromStore`. */
export interface StreamFromStoreParams {
  /** The run whose stored event log to stream. */
  runId: string;
  /** Stream id to resume after. `FIRST_ID` replays from the beginning. */
  since?: string;
  /** `init` frame payload, when the caller wants one. */
  conversationId?: number;
  /** Logger for tail failures. */
  log: Logger;
  /**
   * Milliseconds between keep-alive comments.
   *
   * @default 10000
   */
  heartbeatMs?: number;
  /**
   * Asked only when the stream goes quiet: is this run still running?
   *
   * Returning `false` closes the response, which is what lets a reader on one
   * replica survive the replica holding the run dying.
   */
  isRunAlive: () => Promise<boolean>;
}

/** A row shape the recovery sweep passes to whichever resumer owns its `kind`. */
export type ResumableRow = Awaited<
  ReturnType<typeof findResumableRuns>
>[number];

/**
 * How a run of one `kind` is put back to work.
 *
 * Each kind registers its own adopt function, so a `kind` with no registered
 * resumer is never adopted rather than being handed to the wrong runner.
 */
export interface RunResumer {
  /** Which run kind this resumer handles. */
  kind: RunKind;
  /**
   * Optional discriminator within a kind, read from `runs.input.name`.
   *
   * Omit it when a kind has exactly one runner. Generic workflows all share
   * `kind: "workflow"`, so each supplies its own `name`.
   */
  name?: string;
  /**
   * Re-enters the run.
   *
   * Re-claim the row conditionally before doing any work, and do not throw on a
   * refused claim: losing the race is normal.
   *
   * @param row - The stale row the sweep found.
   */
  adopt: (row: ResumableRow) => Promise<void>;
}

/** Why a retry was refused. */
export type RetryFailureReason =
  | "not_found"
  | "already_running"
  | "attempts_exhausted"
  | "no_runner";

/** What `retryRun` did. */
export type RetryOutcome =
  | {
      ok: true;
      /** The run that was restarted. */
      runId: string;
      /** Its kind. */
      kind: StoredRun["kind"];
      /** Registered resumer name, when the kind uses one. */
      name: string | null;
      /** `true` when a checkpoint existed and the run continues from it. */
      resumed: boolean;
      /** Resumes used now, including this one. */
      attempts: number;
    }
  | {
      ok: false;
      /** Why the retry was refused. */
      reason: RetryFailureReason;
      /** Human-readable explanation. */
      message: string;
      /** Current run status, when the run exists. */
      status?: StoredRun["status"];
      /** Resumes used so far. */
      attempts?: number;
    };

/** Arguments for `attachDetachedWorkflow`. */
export interface DetachedWorkflowArgs {
  /** The id the run will use. Must be the same id passed to the workflow. */
  runId: string;
  /** Which resume strategy this run belongs to. */
  kind: RunKind;
  /** Conversation the run answers, for chat turns. */
  conversationId?: number;
  /** The id the store already holds for this run, when it is being resumed. */
  seedAfterId?: string;
  /** Logger for process-level failures. */
  log: Logger;
}

/** A workflow attached to a registered run. */
export interface DetachedWorkflow {
  /** The registered handle. Its `controller` is what a local abort fires. */
  run: RunHandle;
  /**
   * Wrap a frame sink so every frame also reaches the registry.
   *
   * Frame construction stays in `runProgressFrames`; this only decides that the
   * frames are recorded too, so the response and the replay cannot drift apart.
   */
  tee: (emit: (frame: SseFrame) => void) => (frame: SseFrame) => void;
  /**
   * Publish the terminal frames and schedule disposal.
   *
   * @param result - The final frame to send.
   */
  finish: (result: SseFrame) => void;
  /** Publish a failure frame and schedule disposal. */
  fail: () => void;
}

/** Arguments for `workflowStreamWithRegistry`. */
export interface WorkflowStreamWithRegistryArgs {
  /** The id this run will use. */
  runId: string;
  /** Which resume strategy this run belongs to. */
  kind: RunKind;
  /** Conversation the run answers, for chat turns. */
  conversationId?: number;
  /** Logger for process-level failures. */
  log: Logger;
  /**
   * Milliseconds between keep-alive comments.
   *
   * @default 10000
   */
  heartbeatMs?: number;
  /**
   * The work to run.
   *
   * @param helpers - `emit` writes a frame to both the response and the registry;
   * `signal` aborts when the no one is waiting any more.
   * @returns The final frame to send.
   */
  execute: (helpers: {
    emit: (frame: SseFrame) => void;
    signal: AbortSignal;
  }) => Promise<SseFrame>;
  /** Logs the failure. The client always sees a generic message. */
  onError?: (err: unknown) => void;
}

/**
 * The run lifecycle shared by every long workflow.
 *
 * It guarantees the parts that are silent when wrong: the row exists before the
 * work starts, the lease is claimed and heartbeated, the terminal status is
 * written even on a throw, and cleanup runs in `finally`.
 *
 * @example
 * ```ts
 * const result = await runWorkflow({
 *   options: { kind: "workflow", name: "research", query },
 *   execute: async (ctx) => runResearch(ctx),
 * });
 * ```
 */
export interface WorkflowRunContext<TProgress = WorkflowProgressUpdate> {
  /** The run id. */
  runId: string;
  /** Aborted by the lease heartbeat, so the loop stops spending. */
  leaseSignal: AbortSignal;
  /**
   * Save a resume snapshot.
   *
   * Only the envelope is typed here; `state` inside it belongs to the workflow.
   *
   * @param snapshot - The checkpoint to store.
   */
  saveCheckpoint: (snapshot: Checkpoint) => void;
  /**
   * Read the snapshot a previous process left.
   *
   * @returns The checkpoint, or `null` on a fresh run.
   */
  loadCheckpoint: () => Promise<Checkpoint | null>;
  /**
   * Publish one progress frame.
   *
   * A no-op unless the caller supplied `onProgress`.
   */
  emitProgress: (event: TProgress) => void;
}

/** What a workflow returns when it succeeds. */
export interface WorkflowExecution<TData, TMeta = unknown> {
  /** Terminal payload of the run. */
  data: TData;
  /** Why the run stopped. */
  stopReason: string;
  /** Where the evidence came from, when applicable. */
  source?: string;
  /** Whether the run gathered enough evidence to answer, when applicable. */
  isSufficient?: boolean;
  /** Intents the run never got to, when applicable. */
  missingIntents?: string[];
  /** Workflow-specific metadata forwarded on the payload and stored in `runs.partial`. */
  meta?: TMeta;
}
