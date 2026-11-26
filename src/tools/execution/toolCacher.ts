import { cacheGet, cacheSet, getConfiguration } from "../../config/config";
import type {
  ToolHandler,
  ToolExecutionContext,
} from "../../types/ToolExecutionTypes";
import { generateHash } from "../../utils/hash";

function canonicalizeArgs(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);

  if (Array.isArray(obj)) return `[${obj.map(canonicalizeArgs).join(",")}]`;

  const sortedKeys = Object.keys(obj).sort();
  return `{${sortedKeys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalizeArgs((obj as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}

function isErrorResult(res: unknown): boolean {
  if (!res) return true;

  if (typeof res === "string") {
    return res.startsWith('{"error":');
  }

  if (typeof res === "object") {
    const r = res as Record<string, unknown>;
    if ("error" in r && Boolean(r.error)) return true;
    if ("ok" in r && r.ok === false) return true;
  }

  return false;
}

/**
 * Wrap a tool handler so repeated identical calls are served from the cache.
 *
 * Failed results are never cached, so a transient error is retried next time.
 *
 * @param toolName - Tool name, part of the cache key.
 * @param handler - The handler to wrap.
 * @param ttlSeconds - Cache lifetime in seconds.
 * @default ttlSeconds 3600
 * @param scopeKey - Extra key component, e.g. a user or tenant id.
 * @default scopeKey "global"
 * @param normalizeArgs - Drop or rewrite arguments that should not affect the
 * key, e.g. a timestamp.
 * @returns A handler with the same signature, served from the cache on a hit.
 * @example
 * ```ts
 * const handler = withToolCache("get_weather", getWeather, 600, userId);
 * ```
 */
export function withToolCache(
  toolName: string,
  handler: ToolHandler,
  ttlSeconds = 3600,
  scopeKey = "global",
  normalizeArgs: (a: Record<string, unknown>) => Record<string, unknown> = (
    a,
  ) => a,
): ToolHandler {
  return async (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => {
    const log = getConfiguration().logger;

    const argsHash = generateHash(
      `${toolName}:${scopeKey}:${canonicalizeArgs(normalizeArgs(args))}`,
    );
    const redisKey = `toolcache:${toolName}:${argsHash}`;

    try {
      const cached = await cacheGet<string>(redisKey);
      if (cached) {
        return JSON.parse(cached) as unknown;
      }
    } catch {
      log.warn(
        { toolName, scopeKey },
        "Cache error reading this tool response",
      );
    }

    const result = await handler(args, context);

    if (!isErrorResult(result)) {
      try {
        await cacheSet(
          redisKey,
          JSON.stringify(result),
          ttlSeconds * 1000,
        ).catch(() => {
          log.warn({ toolName, scopeKey }, "Failed to cache tool response");
        });
      } catch {
        log.warn({ toolName, scopeKey }, "Failed to cache tool response");
      }
    }

    return result;
  };
}
