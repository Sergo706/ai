import { aiClients, getConfiguration } from "../config/config";
import type { ToolLoopClient } from "../types/ToolExecutionTypes";
import { withRequestOptions } from "./client";
import type { ChatInput, ModelOptions, ModelRequestOptions } from "./types";

/**
 * Either signal stops the turn; the caller's own is enough on its own.
 *
 * A run owns a controller because another replica has to be able to stop it,
 * and the caller owns one because the browser may go away. Neither can replace
 * the other, so the turn listens to both.
 */
export function combineSignals(
  caller: AbortSignal | undefined,
  owned: AbortSignal | undefined,
): AbortSignal | undefined {
  if (caller === undefined) return owned;
  if (owned === undefined) return caller;

  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  if (caller.aborted || owned.aborted) abort();
  else {
    caller.addEventListener("abort", abort, { once: true });
    owned.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

/** Who is asking, as prompt lines. Empty when the caller supplied nothing. */
export function userContext(user: ChatInput["user"]): string {
  if (user === undefined) return "";

  const lines: string[] = [];
  if (user.locale) lines.push(`- Locale: ${user.locale}`);
  if (user.timezone) lines.push(`- Timezone: ${user.timezone}`);
  if (user.geo) lines.push(`- Geo: ${user.geo}`);
  if (user.currentDate) lines.push(`- Current time: ${user.currentDate}`);
  if (user.other?.length) {
    lines.push(`- Other: ${JSON.stringify(user.other)}`);
  }
  if (lines.length === 0) return "";

  return `\n\nInformation about the user:\n${lines.join("\n")}`;
}

/** Agent settings with this turn's overrides folded on top. */
export function turnModel(
  base: ModelOptions,
  override: ChatInput["model"],
): ModelOptions {
  if (override === undefined) return base;
  return {
    ...base,
    ...override,
    tools: { ...base.tools, ...override.tools },
    body: { ...base.body, ...override.body },
    request: base.request,
  };
}

/** The configured provider client, with the agent's transport defaults applied. */
export function resolveClient(
  request: ModelRequestOptions | undefined,
): ToolLoopClient {
  return withRequestOptions(aiClients("default"), request);
}

/** Logging entry point, resolved once per agent. */
export function logger(): ReturnType<typeof getConfiguration>["logger"] {
  return getConfiguration().logger;
}
