import type { ChatCompletion } from "openai/resources";
import { streamFinalAnswer } from "./streamFinalAnswer";
import { completeFinalAnswer } from "./completeFinalAnswer";
import { AgentEvent, ToolLoopOptions } from "../../types/ToolExecutionTypes";

/** Streaming entry point; yields typed events, never raw provider frames. */
export function executeToolLoop(
  options: ToolLoopOptions & { stream: true },
): AsyncGenerator<AgentEvent>;

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
