import type {
  ExternalDiscoveryAdapter,
  TargetExecutorAdapter,
  WorkflowExecutionContext,
} from "../types";
import type { WorkflowState } from "../WorkflowState";
import { throwIfAborted } from "../executionContext";
import type { EvaluatorPhase } from "./EvaluatorPhase";
import { Logger } from "../../config/configSchema";

/** Outcome of executing the targets discovered for a single intent. */
interface ExecutionOutcome {
  /** How many targets were actually handed to the executor. */
  executed: number;
  /** Whether any of them contributed accepted evidence. */
  addedEvidence: boolean;
}

export class ExternalDiscoveryPhase<
  TLocalItem,
  TDiscoveryPayload,
  TTarget,
  TExternalArtifact,
> {
  constructor(
    private readonly workflowName: string,
    private readonly discovery: ExternalDiscoveryAdapter<
      TDiscoveryPayload,
      TTarget
    >,
    private readonly executor: TargetExecutorAdapter<
      TTarget,
      TExternalArtifact
    >,
    private readonly state: WorkflowState<TLocalItem, TExternalArtifact>,
    private readonly evaluatorPhase: EvaluatorPhase<
      TLocalItem,
      TExternalArtifact
    >,
    private readonly logger: Logger,
    private readonly evaluatePhaseDescription = "The data was just retrieved from external sources. Evidence includes a Retrieved at field; publication dates are not independently verified",
  ) {}

  public async runSeeds(
    seedTargets: TTarget[],
    context: WorkflowExecutionContext,
  ): Promise<void> {
    if (seedTargets.length === 0) return;

    const candidates = this.filterUnattemptedTargets(seedTargets);

    if (candidates.length < seedTargets.length) {
      this.logger.debug(
        {
          workflow: this.workflowName,
          requested: seedTargets.length,
          kept: candidates.length,
          attemptedTargets: this.state.attemptedTargets.size,
        },
        `[${this.workflowName}] Seed targets filtered`,
      );
    }

    if (candidates.length === 0) {
      this.logger.debug(
        { workflow: this.workflowName, requested: seedTargets.length },
        `[${this.workflowName}] Seeds skipped: every target blocked or already attempted`,
      );
      return;
    }

    const added = await this.executor.executeBatch(
      candidates,
      this.state,
      context,
    );

    if (added) {
      this.state.contextIsSufficient = await this.evaluatorPhase.evaluate(
        "URLs provided by user",
        context,
      );
    }
  }

  /** Stage 4: the external discovery round loop. */
  public async runRounds(
    context: WorkflowExecutionContext,
    options: {
      /** Rounds already completed before a resume. The budget still applies. */
      startRound?: number;
      /** Fires after each round's bookkeeping, so the caller can checkpoint. */
      onRoundComplete?: (roundsDone: number) => void;
    } = {},
  ): Promise<void> {
    const startRound = options.startRound ?? 0;
    for (let i = startRound; i < this.state.budgets.maxExternalRounds; i++) {
      throwIfAborted(context.signal, this.workflowName);
      const shouldStop = await this.runRound(i, context);
      options.onRoundComplete?.(this.state.externalRounds);
      if (shouldStop) break;
    }

    if (!this.state.contextIsSufficient) {
      this.logger.debug(
        {
          workflow: this.workflowName,
          externalRounds: this.state.externalRounds,
          maxExternalRounds: this.state.budgets.maxExternalRounds,
          stopReason: this.state.stopReason ?? "budget_exhausted",
          evidenceItems: this.state.evidenceSet.length,
          attemptedTargets: this.state.attemptedTargets.size,
          externalArtifacts: this.state.externalArtifacts.length,
          consecutiveSkippedRounds: this.state.consecutiveSkippedRounds,
          consecutiveRepeatedIntentRounds:
            this.state.consecutiveRepeatedIntentRounds,
          issuedIntents: this.state.issuedIntents.size,
          exhaustedIntents: this.state.exhaustedIntents.size,
          pendingIntents: this.state.pendingIntents,
        },
        this.state.stopReason === "no_new_sources"
          ? `[${this.workflowName}] External search stopped: no new sources available`
          : `[${this.workflowName}] External budget exhausted without sufficient evidence`,
      );
    }
  }

  /**
   * A single targeted pass requested by the critic. It reuses the normal round
   * body but is capped at one pass by `CriticPhase`.
   */
  public async runSingleRefinementRound(
    context: WorkflowExecutionContext,
  ): Promise<void> {
    throwIfAborted(context.signal, this.workflowName);
    this.state.contextIsSufficient = false;
    await this.runRound(this.state.externalRounds, context);
  }

  /** @returns `true` when the loop should stop. */
  private async runRound(
    roundIndex: number,
    context: WorkflowExecutionContext,
  ): Promise<boolean> {
    const { maxIntentsPerRound, maxTargetsPerIntent } = this.state.budgets;

    this.state.externalRounds++;

    // Snapshot the outstanding terms for this round, capped by budget.
    const searchIntents = this.state.pendingIntents.slice(
      0,
      maxIntentsPerRound,
    );

    // `addedEvidence` drives the evaluator; `addedSources` only counts executed
    // targets. Passive metadata is evidence but not a new source, so it must not
    // mask a round where every candidate target was already attempted.
    let addedEvidence = false;
    let addedSources = false;
    let newTargets = 0;
    let skippedIntents = 0;

    this.logger.debug(
      {
        workflow: this.workflowName,
        round: roundIndex,
        maxRounds: this.state.budgets.maxExternalRounds,
        intents: searchIntents,
        evidenceItems: this.state.evidenceSet.length,
        attemptedTargets: this.state.attemptedTargets.size,
        consecutiveSkippedRounds: this.state.consecutiveSkippedRounds,
        consecutiveRepeatedIntentRounds:
          this.state.consecutiveRepeatedIntentRounds,
      },
      `[${this.workflowName}] External round started`,
    );

    if (searchIntents.length === 0) {
      this.state.stopReason = "no_new_sources";
      this.logger.debug(
        {
          workflow: this.workflowName,
          round: roundIndex,
          stopReason: this.state.stopReason,
        },
        `[${this.workflowName}] External search stopped: no outstanding search intents`,
      );
      return true;
    }

    // Never pay for a discovery call on an intent we already exhausted. The
    // terms stay in `pendingIntents` so the final synthesis still knows what
    // could not be verified.
    const dispatchIntents: string[] = [];
    const suppressedIntents: string[] = [];

    for (const intent of searchIntents) {
      if (
        this.state.exhaustedIntents.has(this.evaluatorPhase.fingerprint(intent))
      ) {
        suppressedIntents.push(intent);
      } else {
        dispatchIntents.push(intent);
      }
    }

    if (suppressedIntents.length > 0) {
      this.logger.debug(
        {
          workflow: this.workflowName,
          round: roundIndex,
          suppressedIntents,
          dispatchIntents,
          exhaustedIntents: this.state.exhaustedIntents.size,
        },
        `[${this.workflowName}] Intents not re-dispatched: intent already exhausted`,
      );
    }

    if (dispatchIntents.length === 0) {
      this.state.stopReason = "no_new_sources";
      this.logger.debug(
        {
          workflow: this.workflowName,
          round: roundIndex,
          reason: "all_outstanding_intents_exhausted",
          suppressedIntents,
          exhaustedIntents: this.state.exhaustedIntents.size,
          evidenceItems: this.state.evidenceSet.length,
        },
        `[${this.workflowName}] External search stopped: every outstanding intent was already searched`,
      );
      return true;
    }

    // Fire every discovery call for this round at once. Awaiting them one by one
    // makes an N-intent round cost the SUM of N round-trips instead of the
    // slowest one. Results are consumed in order, so target and evidence
    // ordering stay deterministic.
    const settledResults = await Promise.allSettled(
      dispatchIntents.map((intent) => this.discovery.discover(intent, context)),
    );

    // Only this round's dead ends are surfaced to the evaluator.
    this.state.failedIntents = [];

    for (const [intentIndex, intent] of dispatchIntents.entries()) {
      const settled = settledResults[intentIndex];

      if (settled.status === "rejected") {
        throwIfAborted(context.signal, this.workflowName);
        this.recordDiscoveryFailure(intent, settled.reason, roundIndex);
        continue;
      }

      try {
        // From here on the intent has genuinely been searched, so the evaluator
        // is allowed to have it treated as exhausted later. Passive evidence is
        // recorded first so it lands before any target evidence from this intent.
        this.recordDispatchSuccess(intent, settled.value);

        const outcome = await this.executeDiscoveredTargets(
          intent,
          settled.value,
          maxTargetsPerIntent,
          context,
        );

        newTargets += outcome.executed;

        if (outcome.addedEvidence) {
          addedEvidence = true;
          addedSources = true;
        }

        if (outcome.executed === 0) {
          skippedIntents++;
          this.logger.debug(
            {
              workflow: this.workflowName,
              round: roundIndex,
              intent,
              attemptedTargets: this.state.attemptedTargets.size,
            },
            `[${this.workflowName}] Intent skipped: every candidate target was already attempted`,
          );
        }
      } catch (error: unknown) {
        throwIfAborted(context.signal, this.workflowName);
        // The discovery call itself already succeeded; this is a failure while
        // extracting or executing its results.
        const message = error instanceof Error ? error.message : String(error);

        this.logger.warn(
          {
            err: error,
            workflow: this.workflowName,
            round: roundIndex,
            intent,
          },
          `[${this.workflowName}] Discovery result processing failed`,
        );

        this.state.failedIntents.push(intent);
        this.state.errors.push(
          `Search failed for "${intent}": ${message.slice(0, 200)}`,
        );
      }
    }

    this.logger.debug(
      {
        workflow: this.workflowName,
        round: roundIndex,
        addedEvidence,
        addedSources,
        newTargets,
        skippedIntents,
        evidenceItems: this.state.evidenceSet.length,
        attemptedTargets: this.state.attemptedTargets.size,
        consecutiveSkippedRounds: this.state.consecutiveSkippedRounds,
        consecutiveRepeatedIntentRounds:
          this.state.consecutiveRepeatedIntentRounds,
      },
      `[${this.workflowName}] External round finished`,
    );

    // Round-level skip accounting: a round is skipped when discovery returned
    // only targets we already attempted, so nothing new can be executed and the
    // evaluator has no new material to judge.
    if (newTargets === 0) {
      this.state.consecutiveSkippedRounds++;
    } else {
      this.state.consecutiveSkippedRounds = 0;
    }

    if (addedEvidence) {
      this.state.contextIsSufficient = await this.evaluatorPhase.evaluate(
        this.evaluatePhaseDescription,
        context,
      );

      if (this.state.contextIsSufficient) {
        this.logger.debug(
          { workflow: this.workflowName, round: roundIndex },
          `[${this.workflowName}] External search stopped: evaluator reported sufficient`,
        );
        return true;
      }
    } else if (newTargets === 0) {
      this.logger.debug(
        {
          workflow: this.workflowName,
          round: roundIndex,
          reason: "no_executable_targets",
          intents: searchIntents.length,
          skippedIntents,
          attemptedTargets: this.state.attemptedTargets.size,
        },
        `[${this.workflowName}] Evaluator skipped: no new targets were executed this round`,
      );
    }

    if (
      this.state.consecutiveSkippedRounds >=
        this.state.budgets.maxSkippedExternalRounds &&
      !addedSources
    ) {
      this.state.stopReason = "no_new_sources";
      this.logger.debug(
        {
          workflow: this.workflowName,
          round: roundIndex,
          reason: "consecutive_rounds_without_new_targets",
          consecutiveSkippedRounds: this.state.consecutiveSkippedRounds,
          maxSkippedExternalRounds: this.state.budgets.maxSkippedExternalRounds,
          attemptedTargets: this.state.attemptedTargets.size,
          evidenceItems: this.state.evidenceSet.length,
        },
        `[${this.workflowName}] External search stopped: consecutive rounds with no new targets`,
      );
      return true;
    }

    if (
      this.state.consecutiveRepeatedIntentRounds >=
      this.state.budgets.maxRepeatedIntentRounds
    ) {
      this.state.stopReason = "no_new_sources";
      this.logger.debug(
        {
          workflow: this.workflowName,
          round: roundIndex,
          reason: "evaluator_reissued_exhausted_intents",
          consecutiveRepeatedIntentRounds:
            this.state.consecutiveRepeatedIntentRounds,
          maxRepeatedIntentRounds: this.state.budgets.maxRepeatedIntentRounds,
          issuedIntents: this.state.issuedIntents.size,
          exhaustedIntents: this.state.exhaustedIntents.size,
          evidenceItems: this.state.evidenceSet.length,
        },
        `[${this.workflowName}] External search stopped: evaluator kept re-issuing already-searched intents`,
      );
      return true;
    }

    return false;
  }

  private recordDiscoveryFailure(
    intent: string,
    reason: unknown,
    roundIndex: number,
  ): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    const fingerprint = this.evaluatorPhase.fingerprint(intent);
    const failures = (this.state.discoveryFailures.get(fingerprint) ?? 0) + 1;

    this.state.discoveryFailures.set(fingerprint, failures);

    const exhausted =
      failures >= this.state.budgets.maxDiscoveryFailuresPerIntent;
    if (exhausted) {
      this.state.exhaustedIntents.set(fingerprint, intent);
      this.state.discoveryFailures.delete(fingerprint);
    }

    this.state.failedIntents.push(intent);
    this.state.errors.push(
      `Search failed for "${intent}": ${message.slice(0, 200)}`,
    );

    this.logger.warn(
      {
        err: reason,
        workflow: this.workflowName,
        round: roundIndex,
        intent,
        failures,
        exhausted,
      },
      exhausted
        ? `[${this.workflowName}] Discovery failed: intent exhausted, not retried`
        : `[${this.workflowName}] Discovery failed: will retry next round`,
    );
  }

  /**
   * Marks an intent as dispatched and records its passive (non-triggering)
   * evidence.
   */
  private recordDispatchSuccess(
    intent: string,
    payload: TDiscoveryPayload,
  ): void {
    const fingerprint = this.evaluatorPhase.fingerprint(intent);

    this.state.dispatchedIntents.add(fingerprint);
    this.state.discoveryFailures.delete(fingerprint);

    const passiveEvidence =
      this.discovery.extractPassiveEvidence?.(intent, payload) ?? [];

    let recorded = 0;
    for (const block of passiveEvidence) {
      if (!block.trim()) continue;
      this.state.appendEvidence(block);
      recorded++;
    }

    if (recorded > 0) {
      this.logger.debug(
        {
          workflow: this.workflowName,
          intent,
          passiveBlocks: recorded,
          evidenceItems: this.state.evidenceSet.length,
        },
        `[${this.workflowName}] Passive discovery evidence recorded (does not trigger evaluator)`,
      );
    }
  }

  /**
   * Extracts candidates, drops blocked/attempted ones, caps the batch and hands
   * it to the target executor.
   */
  private async executeDiscoveredTargets(
    intent: string,
    payload: TDiscoveryPayload,
    maxTargetsPerIntent: number,
    context: WorkflowExecutionContext,
  ): Promise<ExecutionOutcome> {
    const candidates = this.discovery.extractCandidates(intent, payload);
    const targets = this.filterUnattemptedTargets(candidates).slice(
      0,
      maxTargetsPerIntent,
    );

    if (targets.length === 0) {
      return { executed: 0, addedEvidence: false };
    }

    const addedEvidence = await this.executor.executeBatch(
      targets,
      this.state,
      context,
    );

    this.logger.debug(
      {
        workflow: this.workflowName,
        intent,
        candidates: candidates.length,
        executed: targets.length,
        addedEvidence,
        evidenceItems: this.state.evidenceSet.length,
      },
      `[${this.workflowName}] Target execution outcome`,
    );

    return { executed: targets.length, addedEvidence };
  }

  /**
   * Drops blocked and already-attempted targets, marking the survivors as
   * attempted (they are about to be handed to the executor).
   */
  private filterUnattemptedTargets(candidates: TTarget[]): TTarget[] {
    const kept: TTarget[] = [];

    for (const target of candidates) {
      if (this.executor.isBlocked?.(target).blocked) continue;

      const key = this.executor.getKey(target);
      if (this.state.attemptedTargets.has(key)) continue;

      this.state.attemptedTargets.add(key);
      kept.push(target);
    }

    return kept;
  }
}
