import { ThinkingEffort } from "../../types/ToolExecutionTypes";

/**
 * DeepSeek accepts `thinking` (not modelled by the OpenAI SDK) plus
 * `reasoning_effort`. Effort is forwarded verbatim; the server maps
 * medium -> high and keeps low/high/max as-is.
 */
export function thinkingParams(
  effort: ThinkingEffort | undefined,
): Record<string, unknown> {
  if (!effort) return {};
  return { reasoning_effort: effort, thinking: { type: "enabled" } };
}
