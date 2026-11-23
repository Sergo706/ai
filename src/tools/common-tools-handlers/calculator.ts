import { evaluate } from "mathjs";
import { ToolHandler } from "../../types/ToolExecutionTypes";
import { toolError } from "../execution";
import { getConfiguration } from "../../config/config";


export function calculator(): ToolHandler {
  const log = getConfiguration().logger;
  return (args) => {
    log.debug({ args }, "agent ran tool calculator");
    const { expression } = args;

    if (typeof expression !== "string") {
      return toolError("INVALID_EXPRESSION", "Expression must be a string.");
    }

    try {
      const result = evaluate(expression) as unknown;
      return String(result);
    } catch (error) {
      log.error({ err: error }, "Math evaluation failed.");
      return toolError(
        "MATH_EVALUATION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}
