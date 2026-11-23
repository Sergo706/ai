import type { MessageTrace, StoredToolStep } from "../db/schema";
import type { AgentEvent } from "../types/ToolExecutionTypes";

/**
 * Collects a message trace from the agent's event stream.
 *
 */
export interface TraceExtension<TExtra extends Record<string, unknown>> {
  /** Inspect one event. Core handling has already run. */
  apply(event: AgentEvent): void;
  /** Extra trace fields to merge, or `undefined` to contribute nothing. */
  toTrace(): TExtra | undefined;
}

export class TraceCollector<
  // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type
  TExtra extends Record<string, unknown> = Record<never, never>,
> {
  protected response = "";
  protected reasoning: MessageTrace["reasoning"] = [];
  protected steps: MessageTrace["steps"] = [];
  private readonly extensions: readonly TraceExtension<TExtra>[];

  constructor(extensions: readonly TraceExtension<TExtra>[] = []) {
    this.extensions = extensions;
  }

  get fullResponse(): string {
    return this.response;
  }

  apply(event: AgentEvent): void {
    if (event.type === "chunk") {
      this.response += event.text;
    } else if (event.type === "reasoning") {
      const round = Number.isInteger(event.round) ? event.round : 0;
      const existing = this.reasoning.find((r) => r.round === round);
      if (existing) existing.text += event.delta;
      else this.reasoning.push({ round, text: event.delta });
    }

    for (const extension of this.extensions) extension.apply(event);
  }

  addStep = (step: StoredToolStep): void => {
    this.steps.push(step);
  };


  toTrace(): (MessageTrace & TExtra) | null {
    let extra: Partial<TExtra> | undefined;

    for (const extension of this.extensions) {
      const contribution = extension.toTrace();
      if (contribution) extra = { ...extra, ...contribution };
    }

    const hasCore = this.reasoning.length > 0 || this.steps.length > 0;
    if (!hasCore && !extra) return null;

    return {
      reasoning: this.reasoning,
      steps: this.steps,
      ...extra,
    } as MessageTrace & TExtra;
  }
}
