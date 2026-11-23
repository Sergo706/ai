import { ChatCompletionTool } from "openai/resources";
import { ToolHandler, ToolStreamPolicy } from "../types/ToolExecutionTypes";
import { withToolCache } from "./execution/toolCacher";
import { limitTool, trackTool } from "./toolWrappers";

export interface ToolFactoryContext<TMeta = unknown> {
  userId: string;
  conversationId?: number;
  meta?: TMeta
}

export interface ToolSpec<TMeta> {
  name: string;
  make: (ctx: ToolFactoryContext<TMeta>) => ToolHandler;
  definitions: ChatCompletionTool
  cache?: {
    ttl: number;
    scoped?: boolean;
    normalizeArgs?: (a: Record<string, unknown>) => Record<string, unknown>;
  };
  maxCalls?: number;
  concurrency?: number;
  stream?: ToolStreamPolicy;
}

export interface ToolRegistry {
  handlers: Readonly<Record<string, ToolHandler>>;
  definitions: Readonly<Record<string, ChatCompletionTool>>;
  toolStreaming: Readonly<Record<string, ToolStreamPolicy>>;
  toolConcurrency: Readonly<Record<string, number>>;
  usedTools: ReadonlySet<string>;
}

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
  return { handlers, definitions, toolStreaming, toolConcurrency, usedTools, };
}
