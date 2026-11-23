import type {
  FinalAnswerAdapter,
  WorkflowExecutionContext,
  WorkflowRunResult,
} from "../types";

export class FinalAnswerPhase<TLocalItem, TExternalArtifact, TReport> {
  constructor(
    private readonly adapter: FinalAnswerAdapter<
      TLocalItem,
      TExternalArtifact,
      TReport
    >,
  ) {}

  /**
   * Whether there is anything worth synthesizing. When the loop collected no
   * evidence at all we skip the (expensive) synthesis call and return the bare
   * result instead.
   */
  public canSynthesize(
    result: WorkflowRunResult<TLocalItem, TExternalArtifact, unknown>,
  ): boolean {
    return (
      result.context.trim().length > 0 ||
      result.localItems.length > 0 ||
      result.externalArtifacts.length > 0
    );
  }

  public async run(
    result: WorkflowRunResult<TLocalItem, TExternalArtifact, unknown>,
    context: WorkflowExecutionContext,
  ): Promise<TReport> {
    return this.adapter.synthesize(result, context);
  }
}
