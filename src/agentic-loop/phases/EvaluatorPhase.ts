import type { EvaluatorAdapter, WorkflowExecutionContext } from "../types";
import type { WorkflowState } from "../WorkflowState";
import { throwIfAborted } from "../executionContext";
import { fingerprintQuery } from "../../utils/queryFingerprint";
import { Logger } from "../../config/configSchema";

export class EvaluatorPhase<TLocalItem, TExternalArtifact> {
  constructor(
    private readonly workflowName: string,
    private readonly query: string,
    private readonly adapter: EvaluatorAdapter,
    private readonly state: WorkflowState<TLocalItem, TExternalArtifact>,
    private readonly logger: Logger,
  ) {}

  public fingerprint(intent: string): string {
    return this.adapter.fingerprint?.(intent) ?? fingerprintQuery(intent);
  }

  public async evaluate(
    phaseDescription: string,
    context: WorkflowExecutionContext,
    coldStart = false,
  ): Promise<boolean> {
    this.logger.debug(
      {
        workflow: this.workflowName,
        phase: phaseDescription,
        coldStart,
        promptEvidenceChars: this.state.evidenceSet.join("").length,
        issuedIntents: this.state.issuedIntents.size,
        exhaustedIntents: this.state.exhaustedIntents.size,
        consecutiveRepeatedIntentRounds:
          this.state.consecutiveRepeatedIntentRounds,
      },
      `[${this.workflowName}] Evaluator input`,
    );
    try {
      const verdict = await this.adapter.evaluate(
        {
          query: this.query,
          phaseDescription,
          evidenceText:
            this.state.evidenceSet.join("\n\n---\n\n") ||
            "No usable evidence was found.",
          issuedOrExhaustedIntents: [
            ...new Set([
              ...this.state.issuedIntents.values(),
              ...this.state.exhaustedIntents.values(),
            ]),
          ],
          exhaustedIntents: [...this.state.exhaustedIntents.values()],
          failedIntents: this.state.failedIntents,
          coldStart,
        },
        context,
      );

      let terms = [
        ...new Set(verdict.nextIntents.map((t) => t.trim()).filter(Boolean)),
      ].slice(0, this.state.budgets.maxIntentsPerRound);

      const evidenceBacked =
        this.state.evidenceSet.length > 0 && verdict.isSufficient;

      if (!evidenceBacked && terms.length === 0) {
        terms = [this.query];
      }

      terms = terms.map((t) => this.adapter.transformIntent?.(t) ?? t);

      this.state.pendingIntents = evidenceBacked ? [] : terms;
      this.logger.debug(
        {
          workflow: this.workflowName,
          phase: phaseDescription,
          evidenceItems: this.state.evidenceSet.length,
          evidenceChars: this.state.evidenceSet.join("").length,
          isSufficient: verdict.isSufficient,
          rawIntents: verdict.nextIntents,
          intentsAfterTruncate: terms,
          failedIntents: this.state.failedIntents,
        },
        `[${this.workflowName}] Evaluator verdict`,
      );

      if (!verdict.isSufficient) {
        const repeats: string[] = [];
        const fresh: string[] = [];

        for (const term of terms) {
          const fp = this.fingerprint(term);
          const alreadySearched =
            this.state.dispatchedIntents.has(fp) ||
            this.state.exhaustedIntents.has(fp);

          if (!alreadySearched) {
            if (!this.state.issuedIntents.has(fp)) {
              this.state.issuedIntents.set(fp, term);
              fresh.push(term);
            }
            continue;
          }

          this.state.exhaustedIntents.set(
            fp,
            this.state.exhaustedIntents.get(fp) ??
              this.state.issuedIntents.get(fp) ??
              term,
          );
          repeats.push(term);
        }

        this.state.lastEvaluationRepeatCount = repeats.length;
        this.state.lastEvaluationAllRepeated =
          terms.length > 0 && repeats.length === terms.length;

        if (this.state.lastEvaluationAllRepeated) {
          this.state.consecutiveRepeatedIntentRounds++;
        } else {
          this.state.consecutiveRepeatedIntentRounds = 0;
        }
        this.logger.debug(
          {
            workflow: this.workflowName,
            phase: phaseDescription,
            freshIntents: fresh.length,
            repeatedIntents: repeats.length,
            allRepeated: this.state.lastEvaluationAllRepeated,
            consecutiveRepeatedIntentRounds:
              this.state.consecutiveRepeatedIntentRounds,
            repeatedTerms: repeats,
            issuedIntents: this.state.issuedIntents.size,
            dispatchedIntents: this.state.dispatchedIntents.size,
            exhaustedIntents: this.state.exhaustedIntents.size,
          },
          repeats.length > 0
            ? `[${this.workflowName}] Evaluator re-issued already-searched intents`
            : `[${this.workflowName}] Evaluator issued fresh intents`,
        );
      } else {
        this.state.lastEvaluationAllRepeated = false;
        this.state.lastEvaluationRepeatCount = 0;
      }

      return evidenceBacked;
    } catch (error: unknown) {
      throwIfAborted(context.signal, this.workflowName);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { err: error, workflow: this.workflowName },
        `Evaluator phase failed: ${message}`,
      );
      this.state.errors.push(`Evaluator failed: ${message}`);
      return false;
    }
  }
}
