import type { LocalKnowledgeAdapter, WorkflowExecutionContext } from "../types";
import type { WorkflowState } from "../WorkflowState";
import type { EvaluatorPhase } from "./EvaluatorPhase";
import { throwIfAborted } from "../executionContext";
import { Logger } from "../../config/configSchema";

/**
 * Generic lift of `SearchDataBaseService.searchDataBase`.
 *
 * Paging, `seenLocalIds` dedupe, similarity logging and the
 * `maxConsecutiveInsufficientLocalBatches` give-up guard are domain-agnostic;
 * everything database-specific (pgvector chunks, local CVE table, cached
 * spreads) lives behind `LocalKnowledgeAdapter`.
 */
export class LocalKnowledgePhase<TLocalItem, TExternalArtifact> {
  constructor(
    private readonly workflowName: string,
    private readonly adapter: LocalKnowledgeAdapter<TLocalItem>,
    private readonly state: WorkflowState<TLocalItem, TExternalArtifact>,
    private readonly evaluatorPhase: EvaluatorPhase<
      TLocalItem,
      TExternalArtifact
    >,
    private readonly logger: Logger,
  ) {}

  public async run(
    context: WorkflowExecutionContext,
    options: {
      /** Batches already completed before a resume. The budget still applies. */
      startBatch?: number;
      /** Fires after each batch's bookkeeping, so the caller can checkpoint. */
      onBatchComplete?: (batchesDone: number) => void;
    } = {},
  ): Promise<void> {
    const { localBatchSize, maxLocalRounds } = this.state.budgets;
    let insufficientBatches = 0;

    for (let i = options.startBatch ?? 0; i < maxLocalRounds; i++) {
      throwIfAborted(context.signal, this.workflowName);
      const offset = i * localBatchSize;
      const batch = await this.adapter.fetchBatch(
        offset,
        localBatchSize,
        this.state,
        context,
      );

      this.state.localSearches++;

      if (batch.length > 0 && this.adapter.getScore) {
        const scores = batch.map((item) => this.adapter.getScore?.(item) ?? 0);
        this.logger.debug(
          {
            workflow: this.workflowName,
            iteration: i,
            minScore: Math.min(...scores).toFixed(3),
            maxScore: Math.max(...scores).toFixed(3),
          },
          `[${this.workflowName}] Local similarity range`,
        );
      }

      this.logger.debug(
        {
          workflow: this.workflowName,
          iteration: i,
          offset,
          requested: localBatchSize,
          returned: batch.length,
          seenLocalIds: this.state.seenLocalIds.size,
        },
        `[${this.workflowName}] Local batch fetched`,
      );

      if (batch.length === 0) {
        this.logger.debug(
          { workflow: this.workflowName, iteration: i },
          `[${this.workflowName}] Local search stopped: empty batch`,
        );
        options.onBatchComplete?.(this.state.localSearches);
        break;
      }

      let addedEvidence = false;
      let addedItems = 0;
      let skippedSeen = 0;
      let skippedEmpty = 0;

      for (const item of batch) {
        const id = this.adapter.getId(item);

        if (this.state.seenLocalIds.has(id)) {
          skippedSeen++;
          continue;
        }

        this.state.seenLocalIds.add(id);

        const block = this.adapter.formatEvidence(item);

        const trimmed = block?.trim();

        if (!trimmed) {
          skippedEmpty++;
          continue;
        }

        addedItems++;

        this.state.localItems.push(item);
        this.state.appendEvidence(trimmed);

        addedEvidence = true;
      }

      this.logger.debug(
        {
          workflow: this.workflowName,
          iteration: i,
          addedItems,
          skippedSeen,
          skippedEmpty,
          addedEvidence,
          totalLocalItems: this.state.localItems.length,
          evidenceItems: this.state.evidenceSet.length,
        },
        `[${this.workflowName}] Local batch processed`,
      );
      let shouldStop = false;

      if (addedEvidence) {
        this.state.contextIsSufficient = await this.evaluatorPhase.evaluate(
          "In the 'Retrieved at' Field",
          context,
        );

        if (this.state.contextIsSufficient) {
          this.logger.debug(
            { workflow: this.workflowName, iteration: i },
            `[${this.workflowName}] Local search stopped: evaluator reported sufficient`,
          );
          shouldStop = true;
        } else {
          insufficientBatches++;

          if (
            insufficientBatches >=
            this.state.budgets.maxConsecutiveInsufficientLocalBatches
          ) {
            this.logger.debug(
              {
                workflow: this.workflowName,
                iteration: i,
                insufficientBatches,
                maxConsecutiveInsufficientLocalBatches:
                  this.state.budgets.maxConsecutiveInsufficientLocalBatches,
                addedItems,
                totalLocalItems: this.state.localItems.length,
                evidenceItems: this.state.evidenceSet.length,
              },
              `[${this.workflowName}] Local search stopped: consecutive insufficient batches limit reached`,
            );
            shouldStop = true;
          }
        }
      } else {
        // A page that contributed nothing breaks the streak: the guard only
        // counts batches that actually grew the dataset.
        insufficientBatches = 0;
      }

      if (!shouldStop && batch.length < localBatchSize) {
        this.logger.debug(
          { workflow: this.workflowName, iteration: i, returned: batch.length },
          `[${this.workflowName}] Local search stopped: short batch (last page)`,
        );
        shouldStop = true;
      }

      options.onBatchComplete?.(this.state.localSearches);
      if (shouldStop) break;
    }
  }
}
