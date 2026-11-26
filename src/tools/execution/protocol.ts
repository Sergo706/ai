import { getConfiguration } from "../../config/config";

export const log = () => getConfiguration().logger;

/**
 * Build the error envelope a tool handler returns to the model.
 *
 * @param code - Short machine-readable code, e.g. `"NOT_FOUND"`.
 * @param message - Human-readable explanation.
 * @returns A JSON string the loop recognises as a failed call.
 * @example
 * ```ts
 * return toolError("NOT_FOUND", `No file named ${name}`);
 * ```
 */
export function toolError(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

export function parseToolArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
}

export function serializeToolResult(
  result: unknown,
  serializeForModel?: (result: unknown) => string,
): string {
  if (serializeForModel !== undefined && typeof result !== "string") {
    try {
      const rendered = serializeForModel(result);
      if (typeof rendered === "string" && rendered.trim() !== "") {
        return rendered;
      }
    } catch (error: unknown) {
      log().warn(
        { err: error },
        "[tools] serializeForModel threw; falling back to JSON",
      );
    }
  }

  const serialized =
    typeof result === "string"
      ? result
      : (JSON.stringify(result) as string | undefined);

  return (
    serialized ??
    toolError("INVALID_TOOL_RESULT", "Handler returned no serializable result.")
  );
}

export function truncateForPreview(
  value: string,
  mode: "full" | "preview" | "none",
) {
  if (mode === "none") return "";
  if (mode === "full" || value.length <= 300) return value;
  return value.slice(0, 300);
}

export function isErrorPayload(value: string): boolean {
  return value.startsWith('{"error":');
}

const UNBOUNDED_CONCURRENCY = Number.MAX_SAFE_INTEGER;
export function normalizeConcurrency(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0)
    return UNBOUNDED_CONCURRENCY;
  return Math.max(1, Math.floor(limit));
}

export function validateBudgets(maxRounds: number, maxCalls: number): void {
  for (const [name, value] of Object.entries({ maxRounds, maxCalls })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer.`);
    }
  }
}
