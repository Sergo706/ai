import {
  cacheGet,
  cacheSet,
  getConfiguration,
} from "../../config/config";
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
        await cacheSet(redisKey, JSON.stringify(result), ttlSeconds * 1000).catch(
          () => {
            log.warn({ toolName, scopeKey }, "Failed to cache tool response");
          },
        );
      } catch {
        log.warn({ toolName, scopeKey }, "Failed to cache tool response");
      }
    }

    return result;
  };
}
