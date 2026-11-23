import type { ToolLoopOptions } from "../../types/ToolExecutionTypes";
import type { ChatCompletion } from "openai/resources";
import { runToolRounds } from "./runRounds";
import { responseUnavailableError } from "./errors";

export async function completeFinalAnswer(
  options: ToolLoopOptions,
): Promise<ChatCompletion> {
  const { completedCompletion, finalRequest } = await runToolRounds(options);

  if (completedCompletion) {
    return completedCompletion;
  }

  if (!finalRequest) {
    throw responseUnavailableError();
  }

  const completion = await options.client.chat.completions.create(
    finalRequest,
    {
      signal: options.signal,
    },
  );

  const finalMessage = completion.choices.at(0)?.message;
  if (
    !finalMessage ||
    finalMessage.tool_calls?.length ||
    finalMessage.function_call
  ) {
    throw new Error(
      "Final completion must contain an assistant message without tool calls.",
    );
  }

  return completion;
}
