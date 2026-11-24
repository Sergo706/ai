import type { MessageTrace, StoredToolStep } from "../db/schema";
import type { AgentEvent } from "../types/ToolExecutionTypes";

/**
 * Extra trace fields contributed by the host.
 *
 * Each extension sees every agent event and returns whatever it wants merged
 * into `ChatTurnResult.trace`. The core fields are always recorded regardless.
 */
export interface TraceExtension<TExtra extends Record<string, unknown>> {
  /** Inspect one event. Core handling has already run. */
  apply(event: AgentEvent): void;
  /** Extra trace fields to merge, or `undefined` to contribute nothing. */
  toTrace(): TExtra | undefined;
}

/**
 * Accumulates a message trace from the agent's event stream.
 *
 * Feeds reasoning rounds and tool steps onto one object a caller can persist
 * alongside the answer.
 *
 * @example
 * ```ts
 * const trace = new TraceCollector([myExtension]);
 * for await (const event of agent) trace.apply(event);
 * const stored = trace.toTrace();
 * ```
 */
export class TraceCollector<
  // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type
  TExtra extends Record<string, unknown> = Record<never, never>,
> {
  protected response = "";
  protected reasoning: MessageTrace["reasoning"] = [];
  protected steps: MessageTrace["steps"] = [];
  private readonly extensions: readonly TraceExtension<TExtra>[];

  /**
   * @param extensions - Host extensions to merge into the trace.
   * Defaults to none.
   */
  constructor(extensions: readonly TraceExtension<TExtra>[] = []) {
    this.extensions = extensions;
  }

  /** The assistant text collected so far. */
  get fullResponse(): string {
    return this.response;
  }

  /**
   * Feed one agent event into the trace.
   *
   * @param event - An event from the agent's stream.
   */
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

  /**
   * Record a completed tool call.
   *
   * @param step - The step to append to the trace.
   */
  addStep = (step: StoredToolStep): void => {
    this.steps.push(step);
  };

  /**
   * The trace to persist, or `null` when nothing was recorded.
   *
   * @returns Reasoning rounds and tool steps, merged with whatever the
   * extensions contributed.
   */
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
