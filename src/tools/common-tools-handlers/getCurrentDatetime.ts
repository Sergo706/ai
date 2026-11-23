import z from "zod"
import { ToolHandler } from "../../types/ToolExecutionTypes";
import { toolError } from "../execution";
import { getConfiguration } from "../../config/config";

export const datetimeParams = z.strictObject({
  timezone: z.string().min(1).max(100).optional(),
});

export function validTimezone(timezone: string): boolean {
  if (/^[+-]/.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function getCurrentDatetime(): ToolHandler {
  const log = getConfiguration().logger;
  return (args) => {
    log.debug({ args }, "agent ran tool getCurrentDatetime");

    const parsed = datetimeParams.safeParse(args);
    if (!parsed.success || !validTimezone(parsed.data.timezone ?? "UTC")) {
      return toolError("VALIDATION_ERROR", "Provide a valid IANA timezone.");
    }

    const now = new Date();
    const timezone = parsed.data.timezone ?? "UTC";

    return {
      isoUtc: now.toISOString(),
      timezone,
      formatted: new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now),
    };
  };
}
