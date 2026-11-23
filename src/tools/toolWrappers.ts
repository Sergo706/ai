import { ToolExecutionContext, ToolHandler } from "../types/ToolExecutionTypes";
import { toolError } from "./execution";

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
