import { parseToolArguments, serializeToolResult, toolError } from "./protocol";
import type {
  ToolCall,
  ToolExecutionContext,
  ToolExecutor,
  ToolHandler,
} from "../../types/ToolExecutionTypes";

export async function executeToolCall(
  call: ToolCall,
  allowedNames: ReadonlySet<string>,
  executor: ToolExecutor | undefined,
  handlers: Readonly<Record<string, ToolHandler>> | undefined,
  context: ToolExecutionContext,
  serializeForModel?: (result: unknown) => string,
): Promise<string> {
  if (call.type !== "function") {
    return toolError(
      "UNSUPPORTED_TOOL_TYPE",
      "Only function tools are supported.",
    );
  }

  if (!allowedNames.has(call.function.name)) {
    return toolError(
      "UNKNOWN_TOOL",
      `Tool '${call.function.name}' is not advertised.`,
    );
  }

  const args = parseToolArguments(call.function.arguments);
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return toolError(
      "INVALID_ARGUMENTS",
      "Tool arguments must be a valid JSON object.",
    );
  }

  const handler =
    handlers && Object.hasOwn(handlers, call.function.name)
      ? handlers[call.function.name]
      : undefined;
  if (!executor && !handler) {
    return toolError(
      "MISSING_HANDLER",
      `No handler registered for '${call.function.name}'.`,
    );
  }

  try {
    let result: unknown;
    if (executor) {
      result = await executor(
        call.function.name,
        args as Record<string, unknown>,
        context,
      );
    } else if (handler) {
      result = await handler(args as Record<string, unknown>, context);
    }
    return serializeToolResult(result, serializeForModel);
  } catch {
    return toolError(
      "TOOL_EXECUTION_FAILED",
      "Tool execution or result serialization failed.",
    );
  }
}
