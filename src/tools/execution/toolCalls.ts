import type { ChatCompletionChunk } from "openai/resources";
import { AssembledCall } from "../../types/ToolExecutionTypes";

export function accumulateToolCall(
  partials: Map<number, AssembledCall>,
  delta: NonNullable<
    Extract<
      ChatCompletionChunk["choices"][number]["delta"],
      { tool_calls?: unknown }
    >["tool_calls"]
  >[number],
): void {
  const entry = partials.get(delta.index) ?? {
    id: "",
    name: "",
    arguments: "",
  };
  if (delta.id) entry.id = delta.id;
  const namePart = delta.function?.name;

  if (namePart) {
    if (!entry.name) entry.name = namePart;
    else if (!entry.name.endsWith(namePart)) entry.name += namePart;
  }

  if (delta.function?.arguments) entry.arguments += delta.function.arguments;
  partials.set(delta.index, entry);
}
