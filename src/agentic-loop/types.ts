import { Logger } from "../config/configSchema";
import type { WorkflowState } from "./WorkflowState";

export type StopReason =
  "sufficient" | "budget_exhausted" | "no_new_sources" | "aborted";
export type EvidenceSource = "local" | "external" | "mixed" | "none";

/** Which stage of the run produced a progress event. */
export type WorkflowStage = "seeds" | "local" | "external" | "critic" | "final";

/**
 * One unit of progress the adapters report while they work.
 *
 * Only labels and loop-owned counters live here. Everything a specific
 * workflow wants to show — a crawled URL, a favicon, a product SKU — goes in
 * `custom`, because the loop neither reads nor interprets it.
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
  /**
   * Workflow-specific payload for the client.
   *
   */
  custom?: Record<string, unknown>;
}

export interface WorkflowProgressEvent extends WorkflowProgressUpdate {
  workflow: string;
  stage: WorkflowStage;
}

/**
 * Handed to every adapter call. `signal` is the run's cancellation token and
 * `emit` reports progress without the adapter knowing which stage it is in.
 */
export interface WorkflowExecutionContext {
  signal?: AbortSignal;
  emit(update: WorkflowProgressUpdate): void;
}

export interface WorkflowBudgets {
  maxLocalRounds: number;
  maxExternalRounds: number;
  localBatchSize: number;
  maxIntentsPerRound: number;
  maxTargetsPerIntent: number;
  maxEvaluatorItems: number;
  maxConsecutiveInsufficientLocalBatches: number;
  maxSkippedExternalRounds: number;
  maxRepeatedIntentRounds: number;
  maxDiscoveryFailuresPerIntent: number;
}

export interface LocalKnowledgeAdapter<TLocalItem> {
  /**
   * Reads one page of local items. Receives `state` so the adapter can keep any
   * cross-batch memory of its own (e.g. `accumulatedMatchingVectors` for vector
   * dedupe) without the generic loop knowing about it.
   */
  fetchBatch(
    offset: number,
    limit: number,
    state: WorkflowState<TLocalItem, unknown>,
    context: WorkflowExecutionContext,
  ): Promise<TLocalItem[]>;
  getId(item: TLocalItem): string | number;
  getScore?(item: TLocalItem): number;
  formatEvidence(item: TLocalItem): string | null;
}

export interface TargetExecutorAdapter<TTarget, TExternalArtifact> {
  getKey(target: TTarget): string;
  isBlocked?(target: TTarget): { blocked: boolean; reason?: string };
  /**
   * Give-up threshold for consecutive targets that produced no evidence
   * (e.g. `RESEARCH_MAX_EMPTY_PAGES`). Owned by the executor because only it
   * knows what "empty" means for its target type, and because `executeBatch`
   * reports a single boolean per batch. The loop does not read this.
   */
  maxConsecutiveEmptyTargets?: number;
  /**
   * Executes a batch of unattempted, non-blocked targets (e.g., crawls URLs,
   * runs nikto/nuclei probes, or simulates DEX swaps).
   * Must push accepted evidence strings into `state.evidenceSet` and raw
   * artifacts into `state.externalArtifacts`.
   * Returns `true` ONLY when at least one target contributed accepted evidence.
   */
  executeBatch(
    targets: TTarget[],
    state: WorkflowState<unknown, TExternalArtifact>,
    context: WorkflowExecutionContext,
  ): Promise<boolean>;
}

export interface ExternalDiscoveryAdapter<TDiscoveryPayload, TTarget> {
  /** Dispatches one intent in parallel with others in the round */
  discover(
    intent: string,
    context: WorkflowExecutionContext,
  ): Promise<TDiscoveryPayload>;
  /**
   * Optional passive context extracted from the discovery payload itself
   * (e.g. Google AI Overview, Shopping PLA, or Nmap service banners).
   * Pushed to `state.evidenceSet` WITHOUT setting `addedEvidence = true`.
   */
  extractPassiveEvidence?(intent: string, payload: TDiscoveryPayload): string[];
  /** Extracts candidate targets to pass to `TargetExecutorAdapter`. */
  extractCandidates(intent: string, payload: TDiscoveryPayload): TTarget[];
}

export interface EvaluatorInput {
  query: string;
  phaseDescription: string;
  evidenceText: string;
  issuedOrExhaustedIntents: string[];
  exhaustedIntents: string[];
  failedIntents: string[];
  coldStart: boolean;
}

export interface EvaluatorVerdict {
  isSufficient: boolean;
  nextIntents: string[];
}

export interface EvaluatorAdapter {
  evaluate(
    input: EvaluatorInput,
    context: WorkflowExecutionContext,
  ): Promise<EvaluatorVerdict>;
  /** Optional hook to scope intents (e.g. appending `site:amazon.com` or target CIDR). */
  transformIntent?(intent: string): string;
  /** Normalizes an intent so rephrasings map to the same key (defaults to `fingerprintQuery`). */
  fingerprint?(intent: string): string;
}

export interface CriticVerdict {
  approved: boolean;
  notes?: string;
  followUpIntents?: string[];
}

export interface CriticAdapter<TLocalItem, TExternalArtifact> {
  review(
    state: WorkflowState<TLocalItem, TExternalArtifact>,
    context: WorkflowExecutionContext,
  ): Promise<CriticVerdict>;
}

export interface WorkflowRunResult<
  TLocalItem,
  TExternalArtifact,
  TReport = undefined,
> {
  isSufficient: boolean;
  source: EvidenceSource;
  stopReason: StopReason;
  context: string;
  localItems: TLocalItem[];
  externalArtifacts: TExternalArtifact[];
  missingIntents: string[];
  localSearches: number;
  externalRounds: number;
  criticNotes?: string;
  errors: string[];
  report?: TReport;
}

export interface FinalAnswerAdapter<TLocalItem, TExternalArtifact, TReport> {
  synthesize(
    result: WorkflowRunResult<TLocalItem, TExternalArtifact, unknown>,
    context: WorkflowExecutionContext,
  ): Promise<TReport>;
}

/**
 * A resumable position in a workflow.
 *
 * Deliberately domain-neutral. The loop fills in `completedStages` and the
 * budget counters it owns; the workflow fills in `state`, whose shape is its
 * own business. Versioning lives in `state` so a workflow can discard a
 * snapshot written by an older build without the loop knowing what changed.
 */
export interface WorkflowCheckpoint {
  /** Stages that ran to completion, in order. Resume skips these. */
  completedStages: WorkflowStage[];
  /** Rounds already spent, so a resume does not get a fresh budget. */
  localSearches: number;
  externalRounds: number;
  /** Workflow-defined progress. Opaque to the loop. */
  state: unknown;
}

export interface AgenticWorkflowConfig<
  TLocalItem,
  TDiscoveryPayload,
  TTarget,
  TExternalArtifact,
  TReport = undefined,
> {
  name: string;
  query: string;
  budgets: WorkflowBudgets;
  seedTargets?: TTarget[];
  skipLocal?: boolean;
  localKnowledge?: LocalKnowledgeAdapter<TLocalItem>;
  externalDiscovery?: ExternalDiscoveryAdapter<TDiscoveryPayload, TTarget>;
  targetExecutor: TargetExecutorAdapter<TTarget, TExternalArtifact>;
  evaluator: EvaluatorAdapter;
  critic?: CriticAdapter<TLocalItem, TExternalArtifact>;
  finalAnswer?: FinalAnswerAdapter<TLocalItem, TExternalArtifact, TReport>;
  /** Cancels the run. Checked between stages and forwarded to every adapter. */
  signal?: AbortSignal;
  /** Per-target progress, e.g. for SSE. Fires from inside the adapters. */
  onProgress?: (event: WorkflowProgressEvent) => void;
  /**
   * Called at every point where the workflow's progress is durable enough to
   * resume from. The snapshot type is chosen by the workflow, not by the loop,
   * because only the workflow knows which of its `TLocalItem` and
   * `TExternalArtifact` values are cheap to persist.
   *
   * Persisting is the caller's job. The loop only reports. A workflow that
   * never wires this is still correct, just not resumable.
   */
  onCheckpoint?: (snapshot: WorkflowCheckpoint) => void;
  /**
   * Where to continue from a snapshot this workflow produced earlier.
   *
   * Restoring the state is a no-op the caller does not have to think about:
   * the loop applies `state` to its own `WorkflowState` before the first stage
   * runs and skips the stages already listed in `completedStages`.
   */
  resumeFrom?: WorkflowCheckpoint;
  logger?: Logger;
}
/**
 * Flat, JSON-safe form of `WorkflowState`. The generic parameters survive
 * because `localItems` and `externalArtifacts` are whatever the workflow chose
 * to persist; a workflow whose artifacts are not serialisable should drop them
 * in its own checkpoint writer rather than change this type.
 */
export interface WorkflowStateSnapshot<TLocalItem, TExternalArtifact> {
  consecutiveSkippedRounds: number;
  consecutiveRepeatedIntentRounds: number;
  issuedIntents: [string, string][];
  dispatchedIntents: string[];
  exhaustedIntents: [string, string][];
  lastEvaluationAllRepeated: boolean;
  lastEvaluationRepeatCount: number;
  contextIsSufficient: boolean;
  pendingIntents: string[];
  localSearches: number;
  externalRounds: number;
  evidenceSet: string[];
  localItems: TLocalItem[];
  externalArtifacts: TExternalArtifact[];
  errors: string[];
  criticNotes?: string;
  discoveryFailures: [string, number][];
  failedIntents: string[];
  seenLocalIds: (string | number)[];
  attemptedTargets: string[];
  stopReason: StopReason | undefined;
}
