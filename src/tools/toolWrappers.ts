import { ToolExecutionContext, ToolHandler } from "../types/ToolExecutionTypes";
import { toolError } from "./execution";

/**
 * Cap how many times one tool may be called in a request.
 *
 * Past the cap the handler does not run; the model gets a `TOOL_LIMIT_REACHED`
 * error telling it to answer with what it already has.
 *
 * @param name - Tool name, also the counting key.
 * @param max - Calls allowed per request.
 * @param handler - The handler to wrap.
 * @param toolCounts - Shared counter map for the request.
 * @returns A handler that refuses calls past the cap.
 */
export const limitTool =
  (
    name: string,
    max: number,
    handler: ToolHandler,
    toolCounts: Map<string, number>,
  ): ToolHandler =>
  async (args, context) => {
    const used = toolCounts.get(name) ?? 0;
    if (used >= max) {
      return toolError(
        "TOOL_LIMIT_REACHED",
        `${name} has been called ${String(max)} times already. Do not call it again — synthesize the final answer from the results you already have.`,
      );
    }
    toolCounts.set(name, used + 1);
    return await handler(args, context);
  };

/**
 * Record that a tool ran, so the turn can report `toolsUsed`.
 *
 * @param name - Tool name to record.
 * @param handler - The handler to wrap.
 * @param usedTools - Set shared by the request.
 * @returns A handler that marks the tool as used before it runs.
 */
export const trackTool = (
  name: string,
  handler: ToolHandler,
  usedTools: Set<string>,
): ToolHandler => {
  return async (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => {
    usedTools.add(name);
    return await handler(args, context);
  };
};
