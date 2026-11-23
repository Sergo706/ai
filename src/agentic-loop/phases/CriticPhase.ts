import type { CriticAdapter, WorkflowExecutionContext } from "../types";
import type { WorkflowState } from "../WorkflowState";
import type { ExternalDiscoveryPhase } from "./ExternalDiscoveryPhase";
import { Logger } from "../../config/configSchema";

export class CriticPhase<
  TLocalItem,
  TDiscoveryPayload,
  TTarget,
  TExternalArtifact,
> {
  constructor(
    private readonly workflowName: string,
    private readonly critic: CriticAdapter<TLocalItem, TExternalArtifact>,
    private readonly state: WorkflowState<TLocalItem, TExternalArtifact>,
    private readonly externalPhase: ExternalDiscoveryPhase<
      TLocalItem,
      TDiscoveryPayload,
      TTarget,
      TExternalArtifact
    > | null,
    private readonly logger: Logger,
  ) {}

  public async run(context: WorkflowExecutionContext): Promise<void> {
    if (this.state.evidenceSet.length === 0) return;

    const verdict = await this.critic.review(this.state, context);
    if (verdict.notes) {
      this.state.criticNotes = verdict.notes;
    }

    if (
      !verdict.approved &&
      verdict.followUpIntents?.length &&
      this.externalPhase
    ) {
      this.logger.debug(
        {
          workflow: this.workflowName,
          followUpIntents: verdict.followUpIntents,
        },
        `[${this.workflowName}] Critic requested 1 follow-up discovery pass`,
      );
      this.state.pendingIntents = verdict.followUpIntents.slice(
        0,
        this.state.budgets.maxIntentsPerRound,
      );
      await this.externalPhase.runSingleRefinementRound(context);
    }
  }
}
