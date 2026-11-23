import type {
  AgentEvent,
  ToolLoopOptions,
} from "../../types/ToolExecutionTypes";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources";
import { RequestAbortedError, responseUnavailableError } from "./errors";
import { runToolRounds } from "./runRounds";
import { thinkingParams } from "./thinking";
import { log } from "./protocol";

/**
 * Streaming entry point. Rounds are already streamed by `runToolRounds`, which emits
 * `reasoning` / `chunk` / tool events directly, so this generator only has to handle
 * the budget-exhausted synthesis call and surface failures as `error` events.
 */
export async function* streamFinalAnswer(
  options: ToolLoopOptions,
): AsyncGenerator<AgentEvent> {
  try {
    const { answerStreamed, finalRequest } = await runToolRounds(options);

    if (answerStreamed) return;

    if (!finalRequest) {
      throw responseUnavailableError();
    }

    const stream = await options.client.chat.completions.create(
      {
        ...(finalRequest as object),
        stream: true,
        ...thinkingParams(options.thinkingEffort),
      } as ChatCompletionCreateParamsStreaming,
      { signal: options.signal },
    );

    let finished = false;

    for await (const chunk of stream) {
      const choice = chunk.choices.find((item) => item.index === 0);
      if (!choice) continue;

      if (
        choice.delta.tool_calls?.length ||
        choice.delta.function_call ||
        choice.finish_reason === "tool_calls" ||
        choice.finish_reason === "function_call"
      ) {
        throw responseUnavailableError();
      }

      if (finished) throw responseUnavailableError();

      const delta = choice.delta as typeof choice.delta & {
        reasoning_content?: string | null;
      };
      if (delta.reasoning_content) {
        yield { type: "reasoning", round: -1, delta: delta.reasoning_content };
      }
      if (choice.delta.content) {
        yield { type: "chunk", text: choice.delta.content };
      }
      if (choice.finish_reason !== null) finished = true;
    }

    if (!finished) throw responseUnavailableError();
  } catch (err) {
    if (options.signal?.aborted) throw new RequestAbortedError();
    if (err instanceof RequestAbortedError) throw err;

    log().error({ err }, "[tools] Final answer stream failed");
    yield {
      type: "error",
      message:
        "I have gathered some information, but reached my internal processing limit before I could finish analyzing it. Please try asking a more specific question, And i will be happy to help.",
    };
  }
}
