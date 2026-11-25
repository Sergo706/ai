import { ThinkingEffort } from "../../types/ToolExecutionTypes";

/**
 * Translate the configured effort into the standard OpenAI-compatible
 * `reasoning_effort` field. Provider-specific flags can be supplied via `body`.
 */
export function thinkingParams(
  effort: ThinkingEffort | undefined,
): Record<string, unknown> {
  if (!effort) return {};
  return { reasoning_effort: effort };
}
