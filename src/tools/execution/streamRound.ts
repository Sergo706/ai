import type {
  AssembledCall,
  RoundOutcome,
  ToolLoopOptions,
} from "../../types/ToolExecutionTypes";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources";
import { thinkingParams } from "./thinking";
import { accumulateToolCall } from "./toolCalls";
import { responseUnavailableError } from "./errors";

/**
 * One assistant round, always streamed. Emits `reasoning` and `chunk` deltas as
 * they arrive and reassembles tool call deltas, which the SDK does not do.
 */
export async function streamRound(
  options: ToolLoopOptions,
  messages: ChatCompletionMessageParam[],
  availableTools: readonly ChatCompletionTool[],
  round: number,
): Promise<RoundOutcome> {
  const { client, model, tools, chat, signal, emit, thinkingEffort, body } =
    options;

  const requestBody = {
    ...body,
    model,
    messages: [...messages],
    temperature: tools.temperature,
    max_tokens: chat.maxTokens,
    tools: availableTools,
    tool_choice: "auto",
    stream: true,
    ...thinkingParams(thinkingEffort),
  } as unknown as ChatCompletionCreateParamsStreaming;

  const stream = await client.chat.completions.create(requestBody, { signal });

  let content = "";
  let finishReason: string | null = null;
  const partials = new Map<number, AssembledCall>();

  for await (const chunk of stream) {
    const choice = chunk.choices.find((item) => item.index === 0);
    if (!choice) continue;

    const delta = choice.delta as typeof choice.delta & {
      reasoning_content?: string | null;
    };

    if (delta.reasoning_content) {
      emit?.({ type: "reasoning", round, delta: delta.reasoning_content });
    }

    if (delta.content) {
      content += delta.content;
      emit?.({ type: "chunk", text: delta.content });
    }

    for (const callDelta of delta.tool_calls ?? []) {
      accumulateToolCall(partials, callDelta);
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  if (finishReason === "length") throw responseUnavailableError();

  if (partials.size > 0) {
    return {
      kind: "tools",
      content,
      calls: [...partials.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => call),
    };
  }

  return { kind: "answer", content };
}
