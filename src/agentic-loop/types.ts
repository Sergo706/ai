import { Logger } from "../config/configSchema";
import type { WorkflowState } from "./WorkflowState";

/** Why a workflow stopped. */
export type StopReason =
  "sufficient" | "budget_exhausted" | "no_new_sources" | "aborted";

/** Where the validated evidence came from. */
export type EvidenceSource = "local" | "external" | "mixed" | "none";

/** Which stage of the run produced a progress event. */
export type WorkflowStage = "seeds" | "local" | "external" | "critic" | "final";

/**
 * One unit of progress the adapters report while they work.
 *
 * Enough for a client to show "what is happening now" without knowing the
 * workflow's internals.
 */
export interface WorkflowProgressUpdate {
  /** Human-readable caption for the unit being worked on. */
  label?: string;
  /** Whether this unit added evidence the evaluator will see. */
  addedEvidence: boolean;
  /** Loop-owned round number, when the stage has rounds. */
  round?: number;
  /** The intent this unit belongs to, when the stage dispatches intents. */
  intent?: string;
  /** Diagnostic message for the log, never rendered as UI content. */
  message?: string;
  /** Workflow-defined payload passed through to the client untouched. */
  custom?: Record<string, unknown>;
}

/** A progress event tagged with the workflow and stage that produced it. */
export interface WorkflowProgressEvent extends WorkflowProgressUpdate {
  workflow: string;
  stage: WorkflowStage;
}

/**
 * Handed to every adapter call.
 *
 * `signal` is the run's cancellation token; `emit` reports progress. The adapter
 * never needs to know which stage it is running in.
 */
export interface WorkflowExecutionContext {
  /** Aborts when the caller cancels the run. */
  signal?: AbortSignal;
  /** Report one unit of progress to the caller's `onProgress`. */
  emit(update: WorkflowProgressUpdate): void;
}

/**
 * How much work one run may do.
 *
 * Every field is a cap the loop enforces, so lowering one always shortens the
 * run. Together they guarantee the loop terminates even if an adapter never
 * reports success.
 */
export interface WorkflowBudgets {
  /** Maximum local batches in the whole run. */
  maxLocalRounds: number;
  /** Maximum external discovery rounds in the whole run. Set `0` to skip the stage. */
  maxExternalRounds: number;
  /** Items requested per local `fetchBatch` call. */
  localBatchSize: number;
  /** Maximum intents the evaluator may return for one round. */
  maxIntentsPerRound: number;
  /** Maximum targets taken from one intent's discovery payload. */
  maxTargetsPerIntent: number;
  /** Evidence blocks kept for the evaluator; oldest are dropped first. */
  maxEvaluatorItems: number;
  /** Local batches without new evidence before the local stage gives up. */
  maxConsecutiveInsufficientLocalBatches: number;
  /** Rounds with no new sources before the run stops with `no_new_sources`. */
  maxSkippedExternalRounds: number;
  /** Rounds the evaluator may re-issue already-searched intents. */
  maxRepeatedIntentRounds: number;
  /** Discovery failures tolerated per intent before it counts as exhausted. */
  maxDiscoveryFailuresPerIntent: number;
}

/**
 * Source of local evidence: content the host already has indexed.
 *
 * Omit it (or set `skipLocal`) to run an external-only workflow.
 *
 * @example
 * ```ts
 * const localKnowledge: LocalKnowledgeAdapter<Chunk> = {
 *   fetchBatch: (offset, limit) => db.search(offset, limit),
 *   getId: (chunk) => chunk.id,
 *   getScore: (chunk) => chunk.score,
 *   formatEvidence: (chunk) => chunk.text,
 * };
 * ```
 */
export interface LocalKnowledgeAdapter<TLocalItem> {
  /**
   * Read one page of local items.
   *
   * @param offset - Items to skip.
   * @param limit - Maximum items to return.
   * @param state - Live run state, for dedupe the adapter wants to keep itself.
   * @param context - Cancellation token and progress emitter.
   * @returns The items in this page, or an empty array when exhausted.
   */
  fetchBatch(
    offset: number,
    limit: number,
    state: WorkflowState<TLocalItem, unknown>,
    context: WorkflowExecutionContext,
  ): Promise<TLocalItem[]>;
  /** Stable id, used to skip items already seen. */
  getId(item: TLocalItem): string | number;
  /** Relevance score, logged per batch and optional. */
  getScore?(item: TLocalItem): number;
  /** Evidence text for one item, or `null` to contribute nothing. */
  formatEvidence(item: TLocalItem): string | null;
}

/**
 * Does the actual work against targets the discovery stage produced.
 *
 * This is the only adapter that can add evidence, so it is required.
 */
export interface TargetExecutorAdapter<TTarget, TExternalArtifact> {
  /** Stable key, used to skip targets already attempted. */
  getKey(target: TTarget): string;
  /** Skip a target without spending work on it, e.g. a blocked host. */
  isBlocked?(target: TTarget): { blocked: boolean; reason?: string };
  /**
   * Consecutive targets that may produce no evidence before the run stops.
   *
   * A hint for your own executor; the loop never reads it.
   */
  maxConsecutiveEmptyTargets?: number;
  /**
   * Execute a batch of targets that were not attempted or blocked yet.
   *
   * Push accepted evidence into `state.evidenceSet` and raw results into
   * `state.externalArtifacts`.
   *
   * @param targets - Targets to work through.
   * @param state - Live run state to record into.
   * @param context - Cancellation token and progress emitter.
   * @returns `true` only when at least one target added evidence.
   */
  executeBatch(
    targets: TTarget[],
    state: WorkflowState<unknown, TExternalArtifact>,
    context: WorkflowExecutionContext,
  ): Promise<boolean>;
}

/**
 * Turns an intent into new targets to execute.
 *
 * Optional: without it the loop only runs `seedTargets`.
 */
export interface ExternalDiscoveryAdapter<TDiscoveryPayload, TTarget> {
  /**
   * Search for one intent. Called in parallel for every intent in a round.
   *
   * @param intent - One search intent from the evaluator.
   * @param context - Cancellation token and progress emitter.
   * @returns The raw payload `extractCandidates` will read.
   */
  discover(
    intent: string,
    context: WorkflowExecutionContext,
  ): Promise<TDiscoveryPayload>;
  /**
   * Evidence taken straight from the discovery payload, e.g. a summary snippet.
   *
   * Recorded without marking the unit as having added evidence.
   */
  extractPassiveEvidence?(intent: string, payload: TDiscoveryPayload): string[];
  /** Candidate targets to hand to the executor. */
  extractCandidates(intent: string, payload: TDiscoveryPayload): TTarget[];
}

/** Everything the evaluator is shown when deciding whether to continue. */
export interface EvaluatorInput {
  /** The original query. */
  query: string;
  /** Which stage is asking, for the evaluator's own logging. */
  phaseDescription: string;
  /** Evidence gathered so far, joined into one string. */
  evidenceText: string;
  /** Intents already searched or dropped as exhausted. */
  issuedOrExhaustedIntents: string[];
  /** Intents dropped because they kept failing or repeating. */
  exhaustedIntents: string[];
  /** Intents whose discovery call failed. */
  failedIntents: string[];
  /** `true` when this is the first evaluation of the run. */
  coldStart: boolean;
}

/** The evaluator's decision: stop, or keep going with these intents. */
export interface EvaluatorVerdict {
  /** `true` ends the run with `stopReason: "sufficient"`. */
  isSufficient: boolean;
  /** New intents to search next round. Ignored when sufficient. */
  nextIntents: string[];
}

/**
 * Decides whether the gathered evidence answers the query.
 *
 * Required. Called between rounds; returning `isSufficient` ends the run.
 *
 * @example
 * ```ts
 * const evaluator: EvaluatorAdapter = {
 *   evaluate: async ({ evidenceText }) => ({
 *     isSufficient: evidenceText.length > 2_000,
 *     nextIntents: ["follow-up question"],
 *   }),
 * };
 * ```
 */
export interface EvaluatorAdapter {
  /**
   * Judge the evidence gathered so far.
   *
   * @param input - Evidence and intent history to judge.
   * @param context - Cancellation token and progress emitter.
   * @returns Whether to stop, and which intents to try next.
   */
  evaluate(
    input: EvaluatorInput,
    context: WorkflowExecutionContext,
  ): Promise<EvaluatorVerdict>;
  /** Rewrite an intent before it is searched, e.g. to scope it to a site. */
  transformIntent?(intent: string): string;
  /**
   * Normalise an intent so rephrasings map to one key.
   *
   * @default fingerprintQuery
   */
  fingerprint?(intent: string): string;
}

/** An optional review of the final state before answering. */
export interface CriticVerdict {
  /** `true` lets the run finish; `false` sends it back for another round. */
  approved: boolean;
  /** Reviewer notes, stored on the result as `criticNotes`. */
  notes?: string;
  /** Extra intents to search when not approved, bounded by the budgets. */
  followUpIntents?: string[];
}

/**
 * Reviews the gathered state and can request follow-up intents.
 *
 * Optional. A rejection with `followUpIntents` sends the run back for another
 * round, still bounded by the budgets.
 */
export interface CriticAdapter<TLocalItem, TExternalArtifact> {
  /**
   * Review the current state.
   *
   * @param state - Everything gathered so far.
   * @param context - Cancellation token and progress emitter.
   * @returns Whether to approve, and any notes or follow-up intents.
   */
  review(
    state: WorkflowState<TLocalItem, TExternalArtifact>,
    context: WorkflowExecutionContext,
  ): Promise<CriticVerdict>;
}

/**
 * Everything a finished run produced, whether it succeeded or exhausted a budget.
 */
export interface WorkflowRunResult<
  TLocalItem,
  TExternalArtifact,
  TReport = undefined,
> {
  /** `true` when the evaluator found the evidence sufficient. */
  isSufficient: boolean;
  /** Which evidence made it into the result. */
  source: EvidenceSource;
  /** Why the run ended. */
  stopReason: StopReason;
  /** Evidence blocks joined into one string for the final answer step. */
  context: string;
  /** Local items the run accepted. */
  localItems: TLocalItem[];
  /** Artifacts the external executor produced. */
  externalArtifacts: TExternalArtifact[];
  /** Intents still unanswered when the run stopped. Empty when sufficient. */
  missingIntents: string[];
  /** Local batches actually run. */
  localSearches: number;
  /** External rounds actually run. */
  externalRounds: number;
  /** Notes from the critic, when one was configured. */
  criticNotes?: string;
  /** Recoverable errors, e.g. failed discovery calls. */
  errors: string[];
  /** Output of the final answer step, when one was configured. */
  report?: TReport;
}

/**
 * Turns the run result into the payload the caller returns.
 *
 * Optional: without it `report` is simply absent from the result.
 */
export interface FinalAnswerAdapter<TLocalItem, TExternalArtifact, TReport> {
  /**
   * Build the final payload.
   *
   * @param result - Everything the run gathered.
   * @param context - Cancellation token and progress emitter.
   * @returns The `report` placed on the run result.
   */
  synthesize(
    result: WorkflowRunResult<TLocalItem, TExternalArtifact, unknown>,
    context: WorkflowExecutionContext,
  ): Promise<TReport>;
}

/**
 * A resumable position in a workflow.
 *
 * Written by the loop at each durable point and handed back through
 * `resumeFrom`. `state` is the workflow's own snapshot, opaque to the loop.
 */
export interface WorkflowCheckpoint {
  /** Stages that ran to completion, in order. Resume skips these. */
  completedStages: WorkflowStage[];
  /** Local batches already spent, so a resume does not get a fresh budget. */
  localSearches: number;
  /** External rounds already spent, so a resume does not get a fresh budget. */
  externalRounds: number;
  /** Workflow-defined progress. Opaque to the loop. */
  state: unknown;
}

/**
 * Configuration for one workflow run.
 *
 * The type parameters thread the workflow's own domain types through the
 * adapters, so each stage is typed against what it actually handles.
 */
export interface AgenticWorkflowConfig<
  TLocalItem,
  TDiscoveryPayload,
  TTarget,
  TExternalArtifact,
  TReport = undefined,
> {
  /** Workflow name, used in logs and in every progress event. */
  name: string;
  /** The question the run tries to answer. Required and non-empty. */
  query: string;
  /** Caps that guarantee the run terminates. */
  budgets: WorkflowBudgets;
  /** Targets to execute before any discovery round. */
  seedTargets?: TTarget[];
  /** Set `true` to skip the local stage entirely. */
  skipLocal?: boolean;
  /** Source of local evidence. Omit for an external-only workflow. */
  localKnowledge?: LocalKnowledgeAdapter<TLocalItem>;
  /** Turns intents into targets. Omit to only run `seedTargets`. */
  externalDiscovery?: ExternalDiscoveryAdapter<TDiscoveryPayload, TTarget>;
  /** Executes targets. Required. */
  targetExecutor: TargetExecutorAdapter<TTarget, TExternalArtifact>;
  /** Decides when the evidence is good enough. Required. */
  evaluator: EvaluatorAdapter;
  /** Optional review step before the run finishes. */
  critic?: CriticAdapter<TLocalItem, TExternalArtifact>;
  /** Optional step that turns the result into a final payload. */
  finalAnswer?: FinalAnswerAdapter<TLocalItem, TExternalArtifact, TReport>;
  /** Cancels the run. Checked between stages and forwarded to every adapter. */
  signal?: AbortSignal;
  /** Per-target progress, e.g. for SSE. Fires from inside the adapters. */
  onProgress?: (event: WorkflowProgressEvent) => void;
  /**
   * Called at every point the run could be resumed from.
   *
   * Persisting the snapshot is your job; the loop only reports it. A workflow
   * that never wires this is still correct, just not resumable.
   */
  onCheckpoint?: (snapshot: WorkflowCheckpoint) => void;
  /**
   * Continue a run from a snapshot this workflow produced earlier.
   *
   * The loop restores `state` and skips the stages listed in
   * `completedStages`.
   */
  resumeFrom?: WorkflowCheckpoint;
  /** Logger for stage diagnostics. Defaults to the global configuration logger. */
  logger?: Logger;
}
/**
 * Flat, JSON-safe form of `WorkflowState`.
 *
 * Produced by `WorkflowState.toCheckpoint` and accepted by
 * `WorkflowState.restore`. Deserialisable with `JSON.stringify`.
 */
export interface WorkflowStateSnapshot<TLocalItem, TExternalArtifact> {
  /** Rounds skipped in a row because they produced no new targets. */
  consecutiveSkippedRounds: number;
  /** Rounds in a row where the evaluator re-issued known intents. */
  consecutiveRepeatedIntentRounds: number;
  /** Intents already searched, as `[fingerprint, intent]` pairs. */
  issuedIntents: [string, string][];
  /** Fingerprints dispatched to discovery. */
  dispatchedIntents: string[];
  /** Intents dropped as unproductive, as `[fingerprint, intent]` pairs. */
  exhaustedIntents: [string, string][];
  /** Whether the last evaluation found every intent repeated. */
  lastEvaluationAllRepeated: boolean;
  /** How many repeated intents the last evaluation returned. */
  lastEvaluationRepeatCount: number;
  /** Whether the evaluator reported the evidence sufficient. */
  contextIsSufficient: boolean;
  /** Intents queued for the next round. */
  pendingIntents: string[];
  /** Local batches already run. */
  localSearches: number;
  /** External rounds already run. */
  externalRounds: number;
  /** Accepted evidence blocks. */
  evidenceSet: string[];
  /** Local items accepted so far. */
  localItems: TLocalItem[];
  /** External artifacts produced so far. */
  externalArtifacts: TExternalArtifact[];
  /** Recoverable errors recorded so far. */
  errors: string[];
  /** Notes from the critic, when one ran. */
  criticNotes?: string;
  /** Discovery failures per intent fingerprint, as `[fingerprint, count]`. */
  discoveryFailures: [string, number][];
  /** Intents whose discovery call failed. */
  failedIntents: string[];
  /** Ids of local items already seen. */
  seenLocalIds: (string | number)[];
  /** Keys of targets already attempted. */
  attemptedTargets: string[];
  /** Set once the run decided why it stopped. */
  stopReason: StopReason | undefined;
}
