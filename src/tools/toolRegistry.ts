import type { ChatCompletionTool } from "openai/resources";
import type {
  ToolHandler,
  ToolStreamPolicy,
} from "../types/ToolExecutionTypes";
import { withToolCache } from "./execution/toolCacher";
import { limitTool, trackTool } from "./toolWrappers";

/** What a tool factory is given when it builds a handler. */
export interface ToolFactoryContext<TMeta = unknown> {
  /** Owner of the conversation the tools serve. */
  userId: string;
  /** Conversation the turn belongs to, when it is persisted. */
  conversationId?: number;
  /** Host-defined fields, taken from the agent config and the turn. */
  meta?: TMeta;
}

/**
 * One tool the agent can offer the model.
 *
 * A spec describes the tool once; `make` builds a fresh handler per request, so
 * a handler can capture the user, the conversation or a connection.
 *
 * @example
 * ```ts
 * const weather: ToolSpec = {
 *   name: "get_weather",
 *   definitions: {
 *     type: "function",
 *     function: {
 *       name: "get_weather",
 *       description: "Current weather for a city",
 *       parameters: { type: "object", properties: { city: { type: "string" } } },
 *     },
 *   },
 *   make: () => async ({ city }) => fetchWeather(String(city)),
 *   cache: { ttl: 600 },
 * };
 * ```
 */
export interface ToolSpec<TMeta> {
  /** Tool name, used in the cache key and in `toolsUsed`. */
  name: string;
  /** Builds the handler for one request. */
  make: (ctx: ToolFactoryContext<TMeta>) => ToolHandler;
  /** OpenAI function definition offered to the model. */
  definitions: ChatCompletionTool;
  /** Serve repeated identical calls from the cache. */
  cache?: {
    /** Cache lifetime in seconds. */
    ttl: number;
    /** Scope the key per user instead of globally. */
    scoped?: boolean;
    /** Drop arguments that should not affect the cache key. */
    normalizeArgs?: (a: Record<string, unknown>) => Record<string, unknown>;
  };
  /** Call cap per request, surfaced as `callTotal` in progress events. */
  maxCalls?: number;
  /** Concurrent calls allowed for this tool. */
  concurrency?: number;
  /** How much of the payload reaches the SSE stream. */
  stream?: ToolStreamPolicy;
}

/** The resolved tools for one request. */
export interface ToolRegistry {
  /** Handlers keyed by tool name. */
  handlers: Readonly<Record<string, ToolHandler>>;
  /** Definitions keyed by tool name. */
  definitions: Readonly<Record<string, ChatCompletionTool>>;
  /** Per-tool stream policy, for the tools that declared one. */
  toolStreaming: Readonly<Record<string, ToolStreamPolicy>>;
  /** Per-tool concurrency limits. */
  toolConcurrency: Readonly<Record<string, number>>;
  /** Tool names the model actually called, filled in during the turn. */
  usedTools: ReadonlySet<string>;
}

/**
 * Build the per-request registry from the agent's tool specs.
 *
 * Applies the call cap, the cache and the usage tracking in that order, so the
 * cache sees the capped handler and the tracker sees everything.
 *
 * @param ctx - The user, conversation and host metadata.
 * @param specs - The tools to build.
 * @returns Handlers, definitions and policies, all keyed by tool name.
 */
export function buildToolRegistry<TMeta>(
  ctx: ToolFactoryContext<TMeta>,
  specs: readonly ToolSpec<TMeta>[],
): ToolRegistry {
  const usedTools = new Set<string>();
  const counts = new Map<string, number>();
  const handlers: Record<string, ToolHandler> = {};
  const definitions: Record<string, ChatCompletionTool> = {};
  const toolStreaming: Record<string, ToolStreamPolicy> = {};
  const toolConcurrency: Record<string, number> = {};

  for (const spec of specs) {
    let handler = spec.make(ctx);

    if (spec.maxCalls !== undefined)
      handler = limitTool(spec.name, spec.maxCalls, handler, counts);
    if (spec.cache)
      handler = withToolCache(
        spec.name,
        handler,
        spec.cache.ttl,
        spec.cache.scoped ? ctx.userId : "global",
        spec.cache.normalizeArgs,
      );
    handlers[spec.name] = trackTool(spec.name, handler, usedTools);
    definitions[spec.name] = spec.definitions;

    if (spec.stream || spec.maxCalls !== undefined) {
      toolStreaming[spec.name] = {
        ...spec.stream,
        ...(spec.maxCalls !== undefined && { maxCalls: spec.maxCalls }),
      };
    }
    if (spec.concurrency !== undefined)
      toolConcurrency[spec.name] = spec.concurrency;
  }
  return { handlers, definitions, toolStreaming, toolConcurrency, usedTools };
}
