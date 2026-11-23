import type {
  EvidenceSource,
  StopReason,
  WorkflowBudgets,
  WorkflowRunResult,
  WorkflowStateSnapshot,
} from "./types";

export class WorkflowState<TLocalItem, TExternalArtifact> {
  public readonly budgets: WorkflowBudgets;

  public consecutiveSkippedRounds = 0;
  public consecutiveRepeatedIntentRounds = 0;

  public issuedIntents = new Map<string, string>();
  public dispatchedIntents = new Set<string>();
  public exhaustedIntents = new Map<string, string>();

  public lastEvaluationAllRepeated = false;
  public lastEvaluationRepeatCount = 0;

  public contextIsSufficient = false;
  public pendingIntents: string[];
  public localSearches = 0;
  public externalRounds = 0;

  public evidenceSet: string[] = [];
  public localItems: TLocalItem[] = [];
  public externalArtifacts: TExternalArtifact[] = [];
  public errors: string[] = [];
  public criticNotes?: string;

  public discoveryFailures = new Map<string, number>();
  public failedIntents: string[] = [];

  public seenLocalIds = new Set<string | number>();
  public attemptedTargets = new Set<string>();
  public stopReason: StopReason | undefined;

  constructor(initialQuery: string, budgets: WorkflowBudgets) {
    this.pendingIntents = [initialQuery];
    this.budgets = budgets;
  }

  /** Marks the run aborted so `buildResult` reports it instead of a budget stop. */
  public markAborted(): void {
    this.stopReason = "aborted";
  }

  /**
   * Serialises everything a resume needs.
   *
   * Only the progress is written. Budgets and thresholds are intentionally left
   * out so a tunable changed between the crash and the resume takes effect
   * instead of being frozen at the value the dead process was using. Every
   * container is flattened because JSON has no Map or Set.
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
   * Copies a snapshot back over this instance.
   *
   * Called from the constructor, so the loop can build the state from current
   * config and then rewind only the progress. The snapshot is deliberately
   * partial: a checkpoint written by an older build may not carry every field,
   * and anything absent keeps its freshly-constructed value rather than
   * becoming `undefined`. Every container is copied so the live state cannot
   * mutate the snapshot it came from.
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

  public appendEvidence(block: string) {
    this.evidenceSet.push(block);
    if (this.evidenceSet.length > this.budgets.maxEvaluatorItems) {
      this.evidenceSet.splice(
        0,
        this.evidenceSet.length - this.budgets.maxEvaluatorItems,
      );
    }
  }

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
