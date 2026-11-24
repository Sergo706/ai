import type {
  AgenticWorkflowConfig,
  WorkflowRunResult,
  WorkflowStage,
} from "./types";
import { WorkflowState } from "./WorkflowState";
import { bindStage, throwIfAborted } from "./executionContext";
import { EvaluatorPhase } from "./phases/EvaluatorPhase";
import { LocalKnowledgePhase } from "./phases/LocalKnowledgePhase";
import { ExternalDiscoveryPhase } from "./phases/ExternalDiscoveryPhase";
import { CriticPhase } from "./phases/CriticPhase";
import { FinalAnswerPhase } from "./phases/FinalAnswerPhase";
import { getConfiguration } from "../config/config";

/**
 * Runs a multi-stage research loop: seeds, local evidence, external discovery,
 * critic, final answer.
 *
 * You supply each stage as an adapter. The loop owns stage ordering, budgeting,
 * progress reporting and checkpointing between them.
 *
 * @example
 * ```ts
 * const loop = new AgenticWorkflowLoop({
 *   name: "research",
 *   query: "how does pgvector index work",
 *   budgets,
 *   targetExecutor: myExecutor,
 *   evaluator: myEvaluator,
 * });
 *
 * const result = await loop.run();
 * console.log(result.isSufficient, result.context);
 * ```
 */
export class AgenticWorkflowLoop<
  TLocalItem,
  TDiscoveryPayload,
  TTarget,
  TExternalArtifact,
  TReport = undefined,
> {
  private readonly state: WorkflowState<TLocalItem, TExternalArtifact>;
  private readonly evaluatorPhase: EvaluatorPhase<
    TLocalItem,
    TExternalArtifact
  >;
  private readonly localPhase: LocalKnowledgePhase<
    TLocalItem,
    TExternalArtifact
  > | null;
  private readonly externalPhase: ExternalDiscoveryPhase<
    TLocalItem,
    TDiscoveryPayload,
    TTarget,
    TExternalArtifact
  > | null;
  private readonly criticPhase: CriticPhase<
    TLocalItem,
    TDiscoveryPayload,
    TTarget,
    TExternalArtifact
  > | null;
  private readonly finalPhase: FinalAnswerPhase<
    TLocalItem,
    TExternalArtifact,
    TReport
  > | null;

  /**
   * @param config - The stages to run and the budgets that bound them.
   * @throws If `config.query` is empty.
   */
  constructor(
    private readonly config: AgenticWorkflowConfig<
      TLocalItem,
      TDiscoveryPayload,
      TTarget,
      TExternalArtifact,
      TReport
    >,
  ) {
    if (!config.query.trim()) {
      throw new Error(`${config.name} query cannot be empty`);
    }
    const logger = getConfiguration().logger;
    
    this.state = new WorkflowState(config.query, config.budgets);

    const resume = config.resumeFrom;
    if (resume && typeof resume.state === "object" && resume.state !== null) {
      this.state.restore(resume.state);
    }

    this.evaluatorPhase = new EvaluatorPhase(
      config.name,
      config.query,
      config.evaluator,
      this.state,
      logger,
    );

    this.localPhase = config.localKnowledge
      ? new LocalKnowledgePhase(
          config.name,
          config.localKnowledge,
          this.state,
          this.evaluatorPhase,
          logger,
        )
      : null;

    this.externalPhase = config.externalDiscovery
      ? new ExternalDiscoveryPhase(
          config.name,
          config.externalDiscovery,
          config.targetExecutor,
          this.state,
          this.evaluatorPhase,
          logger,
        )
      : null;

    this.criticPhase = config.critic
      ? new CriticPhase(
          config.name,
          config.critic,
          this.state,
          this.externalPhase,
          logger,
        )
      : null;

    this.finalPhase = config.finalAnswer
      ? new FinalAnswerPhase(config.finalAnswer)
      : null;
  }

  /**
   * Run every configured stage in order and return what was gathered.
   *
   * Stops early when the evaluator is satisfied, a budget runs out, or `signal`
   * fires. `result.stopReason` says which of those happened. An abort is a
   * normal outcome here: it resolves with `stopReason: "aborted"` instead of
   * throwing.
   *
   * @returns The evidence, artifacts, counters and optional report.
   */
  public async run(): Promise<
    WorkflowRunResult<TLocalItem, TExternalArtifact, TReport>
  > {
    const sink = {
      workflow: this.config.name,
      signal: this.config.signal,
      onProgress: this.config.onProgress,
    };

    const done = new Set(this.config.resumeFrom?.completedStages ?? []);
    const resume = this.config.resumeFrom;

    try {
      if (
        !done.has("seeds") &&
        this.config.seedTargets?.length &&
        this.externalPhase
      ) {
        throwIfAborted(sink.signal, this.config.name);
        await this.externalPhase.runSeeds(
          this.config.seedTargets,
          bindStage(sink, "seeds"),
        );
        this.saveCheckpoint(["seeds"]);
        if (this.state.contextIsSufficient) {
          return await this.finalize();
        }
      }

      if (!done.has("local") && !this.config.skipLocal && this.localPhase) {
        throwIfAborted(sink.signal, this.config.name);
        await this.localPhase.run(bindStage(sink, "local"), {
          startBatch: resume?.localSearches ?? 0,
          onBatchComplete: () => {
            this.saveCheckpoint(["seeds", "local"]);
          },
        });
        this.saveCheckpoint(["seeds", "local"]);
        if (this.state.contextIsSufficient) {
          return await this.finalize();
        }
      }

      if (
        this.state.evidenceSet.length === 0 &&
        this.config.budgets.maxExternalRounds > 0
      ) {
        throwIfAborted(sink.signal, this.config.name);
        await this.evaluatorPhase.evaluate(
          "No evidence: the internal index returned nothing for this query.",
          bindStage(sink, "external"),
          true,
        );
        if (this.state.pendingIntents.length === 0) {
          const fallback = this.config.evaluator.transformIntent
            ? this.config.evaluator.transformIntent(this.config.query)
            : this.config.query;
          this.state.pendingIntents = [fallback];
        }
      }

      if (
        !done.has("external") &&
        this.externalPhase &&
        this.config.budgets.maxExternalRounds > 0
      ) {
        throwIfAborted(sink.signal, this.config.name);
        await this.externalPhase.runRounds(bindStage(sink, "external"), {
          startRound: resume?.externalRounds ?? 0,
          onRoundComplete: () => {
            this.saveCheckpoint(["seeds", "local", "external"]);
          },
        });
        this.saveCheckpoint(["seeds", "local", "external"]);
      }

      if (!done.has("critic") && this.criticPhase) {
        throwIfAborted(sink.signal, this.config.name);
        await this.criticPhase.run(bindStage(sink, "critic"));
        this.saveCheckpoint(["seeds", "local", "external", "critic"]);
      }

      return await this.finalize();
    } catch (error: unknown) {
      if (sink.signal?.aborted) {
        this.state.markAborted();
        return this.state.buildResult<TReport>();
      }
      throw error;
    }
  }

  private saveCheckpoint(completedStages: WorkflowStage[]): void {
    if (!this.config.onCheckpoint) return;
    try {
      this.config.onCheckpoint({
        completedStages,
        localSearches: this.state.localSearches,
        externalRounds: this.state.externalRounds,
        state: this.state.toCheckpoint(),
      });
    } catch (err: unknown) {
      this.config.logger?.warn(
        { err, workflow: this.config.name },
        `[${this.config.name}] Checkpoint callback failed`,
      );
    }
  }

  private async finalize(): Promise<
    WorkflowRunResult<TLocalItem, TExternalArtifact, TReport>
  > {
    const baseResult = this.state.buildResult<TReport>();
    if (!this.finalPhase?.canSynthesize(baseResult)) {
      return baseResult;
    }
    const context = bindStage(
      {
        workflow: this.config.name,
        signal: this.config.signal,
        onProgress: this.config.onProgress,
      },
      "final",
    );
    const report = await this.finalPhase.run(baseResult, context);
    return { ...baseResult, report };
  }
}
