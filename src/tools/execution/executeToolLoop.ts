import type { ChatCompletion } from "openai/resources";
import { streamFinalAnswer } from "./streamFinalAnswer";
import { completeFinalAnswer } from "./completeFinalAnswer";
import { AgentEvent, ToolLoopOptions } from "../../types/ToolExecutionTypes";

/**
 * Run a turn, calling tools until the model answers.
 *
 * With `stream: true` it yields typed {@link AgentEvent}s; otherwise it resolves
 * with the final completion. The loop is bounded by `tools.maxRounds` and
 * `tools.maxCalls`.
 *
 * @param options - Client, messages, tools and sampling settings.
 * @returns The final completion, or an async generator of events when streaming.
 * @example
 * ```ts
 * for await (const event of executeToolLoop({ ...opts, stream: true })) {
 *   send(frame(event));
 * }
 * ```
 */
export function executeToolLoop(
  options: ToolLoopOptions & { stream: true },
): AsyncGenerator<AgentEvent>;

/** Non-streaming overload: resolve with the final completion. */
export function executeToolLoop(
  options: ToolLoopOptions & { stream?: false },
): Promise<ChatCompletion>;

export function executeToolLoop(
  options: ToolLoopOptions,
): Promise<ChatCompletion> | AsyncGenerator<AgentEvent>;

export function executeToolLoop(
  options: ToolLoopOptions,
): Promise<ChatCompletion> | AsyncGenerator<AgentEvent> {
  return options.stream
    ? streamFinalAnswer(options)
    : completeFinalAnswer(options);
}
