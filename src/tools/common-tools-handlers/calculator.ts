import { ToolHandler } from "../../types/ToolExecutionTypes";
import { toolError } from "../execution";
import { getConfiguration } from "../../config/config";
import { loadPeer } from "../../utils/loadPeerDepend";

interface MathjsPeer {
  evaluate: (expression: string) => unknown;
}

/**
 * Evaluate an arithmetic expression.
 *
 * Backed by `mathjs`, which is loaded on first use.
 *
 * @returns A handler that takes `{ expression }` and returns the result as text.
 */
export function calculator(): ToolHandler {
  const log = getConfiguration().logger;
  return async (args) => {
    log.debug({ args }, "agent ran tool calculator");
    const { expression } = args;

    if (typeof expression !== "string") {
      return toolError("INVALID_EXPRESSION", "Expression must be a string.");
    }

    try {
      const { evaluate } = await loadPeer<MathjsPeer>(
        "mathjs",
        "the calculator tool",
      );
      const result = evaluate(expression);
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
