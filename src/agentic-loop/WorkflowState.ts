import type {
  EvidenceSource,
  StopReason,
  WorkflowBudgets,
  WorkflowRunResult,
  WorkflowStateSnapshot,
} from "./types";

/**
 * Everything a running workflow accumulates.
 *
 * Adapters read and write this to record evidence, remember which items were
 * already seen, and track how much of the budget is spent.
 *
 * @example
 * ```ts
 * const state = new WorkflowState("my query", budgets);
 * state.appendEvidence("a relevant paragraph");
 * const result = state.buildResult();
 * ```
 */
export class WorkflowState<TLocalItem, TExternalArtifact> {
  /** Caps this run must respect. Read-only once constructed. */
  public readonly budgets: WorkflowBudgets;

  /** Rounds skipped in a row that produced no new targets. */
  public consecutiveSkippedRounds = 0;
  /** Rounds in a row where the evaluator re-issued already-searched intents. */
  public consecutiveRepeatedIntentRounds = 0;

  /** Intents already searched, keyed by fingerprint. */
  public issuedIntents = new Map<string, string>();
  /** Fingerprints already dispatched to discovery. */
  public dispatchedIntents = new Set<string>();
  /** Intents dropped as unproductive, keyed by fingerprint. */
  public exhaustedIntents = new Map<string, string>();

  /** Whether the last evaluation found every intent already searched. */
  public lastEvaluationAllRepeated = false;
  /** How many repeated intents the last evaluation returned. */
  public lastEvaluationRepeatCount = 0;

  /** Whether the evaluator reported the evidence sufficient. */
  public contextIsSufficient = false;
  /** Intents queued for the next round. Starts as the query. */
  public pendingIntents: string[];
  /** Local batches already run. */
  public localSearches = 0;
  /** External rounds already run. */
  public externalRounds = 0;

  /** Accepted evidence blocks, oldest dropped past `maxEvaluatorItems`. */
  public evidenceSet: string[] = [];
  /** Local items the run accepted. */
  public localItems: TLocalItem[] = [];
  /** External artifacts the executor produced. */
  public externalArtifacts: TExternalArtifact[] = [];
  /** Recoverable errors, e.g. a failed discovery call. */
  public errors: string[] = [];
  /** Notes left by the critic, when one is configured. */
  public criticNotes?: string;

  /** Discovery failures per intent fingerprint. */
  public discoveryFailures = new Map<string, number>();
  /** Intents whose discovery call failed at least once. */
  public failedIntents: string[] = [];

  /** Ids of local items already seen, used to skip duplicates. */
  public seenLocalIds = new Set<string | number>();
  /** Keys of targets already attempted. */
  public attemptedTargets = new Set<string>();
  /** Why the run stopped, once something set it. */
  public stopReason: StopReason | undefined;

  /**
   * @param initialQuery - First intent queued for the run.
   * @param budgets - Caps this run must respect.
   */
  constructor(initialQuery: string, budgets: WorkflowBudgets) {
    this.pendingIntents = [initialQuery];
    this.budgets = budgets;
  }

  /** Marks the run aborted, so `buildResult` reports `aborted` as the stop reason. */
  public markAborted(): void {
    this.stopReason = "aborted";
  }

  /**
   * Serialise what a resume needs.
   *
   * Progress only: budgets and thresholds are left out so a configuration
   * change takes effect on resume instead of staying frozen.
   *
   * @returns A JSON-safe snapshot suitable for `resumeFrom`.
   */
  public toCheckpoint(): WorkflowStateSnapshot<TLocalItem, TExternalArtifact> {
    return {
      consecutiveSkippedRounds: this.consecutiveSkippedRounds,
      consecutiveRepeatedIntentRounds: this.consecutiveRepeatedIntentRounds,
      issuedIntents: [...this.issuedIntents.entries()],
      dispatchedIntents: [...this.dispatchedIntents],
      exhaustedIntents: [...this.exhaustedIntents.entries()],
      lastEvaluationAllRepeated: this.lastEvaluationAllRepeated,
      lastEvaluationRepeatCount: this.lastEvaluationRepeatCount,
      contextIsSufficient: this.contextIsSufficient,
      pendingIntents: this.pendingIntents,
      localSearches: this.localSearches,
      externalRounds: this.externalRounds,
      evidenceSet: this.evidenceSet,
      localItems: this.localItems,
      externalArtifacts: this.externalArtifacts,
      errors: this.errors,
      criticNotes: this.criticNotes,
      discoveryFailures: [...this.discoveryFailures.entries()],
      failedIntents: this.failedIntents,
      seenLocalIds: [...this.seenLocalIds],
      attemptedTargets: [...this.attemptedTargets],
      stopReason: this.stopReason,
    };
  }

  /**
   * Copy a snapshot back over this instance.
   *
   * Fields the snapshot does not carry keep their current value, so a snapshot
   * from an older build still restores.
   *
   * @param snapshot - A snapshot from `toCheckpoint`, possibly partial.
   */
  public restore(
    snapshot: Partial<WorkflowStateSnapshot<TLocalItem, TExternalArtifact>>,
  ): void {
    this.consecutiveSkippedRounds =
      snapshot.consecutiveSkippedRounds ?? this.consecutiveSkippedRounds;
    this.consecutiveRepeatedIntentRounds =
      snapshot.consecutiveRepeatedIntentRounds ??
      this.consecutiveRepeatedIntentRounds;
    this.issuedIntents = snapshot.issuedIntents
      ? new Map(snapshot.issuedIntents)
      : this.issuedIntents;
    this.dispatchedIntents = snapshot.dispatchedIntents
      ? new Set(snapshot.dispatchedIntents)
      : this.dispatchedIntents;
    this.exhaustedIntents = snapshot.exhaustedIntents
      ? new Map(snapshot.exhaustedIntents)
      : this.exhaustedIntents;
    this.lastEvaluationAllRepeated =
      snapshot.lastEvaluationAllRepeated ?? this.lastEvaluationAllRepeated;
    this.lastEvaluationRepeatCount =
      snapshot.lastEvaluationRepeatCount ?? this.lastEvaluationRepeatCount;
    this.contextIsSufficient =
      snapshot.contextIsSufficient ?? this.contextIsSufficient;
    this.pendingIntents = snapshot.pendingIntents
      ? [...snapshot.pendingIntents]
      : this.pendingIntents;
    this.localSearches = snapshot.localSearches ?? this.localSearches;
    this.externalRounds = snapshot.externalRounds ?? this.externalRounds;
    this.evidenceSet = snapshot.evidenceSet
      ? [...snapshot.evidenceSet]
      : this.evidenceSet;
    this.localItems = snapshot.localItems
      ? [...snapshot.localItems]
      : this.localItems;
    this.externalArtifacts = snapshot.externalArtifacts
      ? [...snapshot.externalArtifacts]
      : this.externalArtifacts;
    this.errors = snapshot.errors ? [...snapshot.errors] : this.errors;
    this.criticNotes = snapshot.criticNotes ?? this.criticNotes;
    this.discoveryFailures = snapshot.discoveryFailures
      ? new Map(snapshot.discoveryFailures)
      : this.discoveryFailures;
    this.failedIntents = snapshot.failedIntents
      ? [...snapshot.failedIntents]
      : this.failedIntents;
    this.seenLocalIds = snapshot.seenLocalIds
      ? new Set(snapshot.seenLocalIds)
      : this.seenLocalIds;
    this.attemptedTargets = snapshot.attemptedTargets
      ? new Set(snapshot.attemptedTargets)
      : this.attemptedTargets;
    this.stopReason = snapshot.stopReason ?? this.stopReason;
  }

  /**
   * Record an evidence block, dropping the oldest past `maxEvaluatorItems`.
   *
   * @param block - Evidence text to record.
   */
  public appendEvidence(block: string) {
    this.evidenceSet.push(block);
    if (this.evidenceSet.length > this.budgets.maxEvaluatorItems) {
      this.evidenceSet.splice(
        0,
        this.evidenceSet.length - this.budgets.maxEvaluatorItems,
      );
    }
  }

  /**
   * Build the result object returned by the run.
   *
   * @param report - Output of the final answer step, when one ran.
   * @returns Evidence, artifacts, counters and the stop reason.
   */
  public buildResult<TReport = undefined>(
    report?: TReport,
  ): WorkflowRunResult<TLocalItem, TExternalArtifact, TReport> {
    let source: EvidenceSource = "none";

    if (this.localItems.length > 0 && this.externalArtifacts.length > 0) {
      source = "mixed";
    } else if (this.localItems.length > 0) {
      source = "local";
    } else if (this.externalArtifacts.length > 0) {
      source = "external";
    }

    const stopReason: StopReason = this.contextIsSufficient
      ? "sufficient"
      : (this.stopReason ?? "budget_exhausted");
    return {
      isSufficient: this.contextIsSufficient,
      source,
      stopReason,
      context: this.evidenceSet.join("\n\n---\n\n"),
      localItems: this.localItems,
      externalArtifacts: this.externalArtifacts,
      missingIntents: this.contextIsSufficient ? [] : this.pendingIntents,
      localSearches: this.localSearches,
      externalRounds: this.externalRounds,
      criticNotes: this.criticNotes,
      errors: this.errors,
      report,
    };
  }
}
