import type { ChatCompletionTool } from "openai/resources";
import { createMcpToolset } from "../tools/mcpConnector";
import type { McpToolset } from "../types/mcp";
import { buildToolRegistry, type ToolSpec } from "../tools/toolRegistry";
import { resolveCommonTools } from "../tools/common-tools-handlers/specs";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import type { ToolOptions } from "./types";

/**
 * A ready-to-use tool set: specs to execute, definitions to advertise.
 *
 * MCP tools appear in `definitions` but not in `specs`. The connector lists
 * what a server offers; calling it needs a handler the host supplies, so a
 * definition it cannot execute is exactly the shape a spec cannot describe.
 */
export interface AssembledTools<TMeta> {
  specs: readonly ToolSpec<TMeta>[];
  definitions: readonly (ChatCompletionTool | ChatCompletionFunctionTool)[];
  mcp: McpToolset | undefined;
}

/**
 * Builds the agent's tools once, at construction.
 *
 * Duplicates are rejected here rather than at call time: two sources claiming
 * one name means the registry would silently keep one and the model would be
 * given the other, which is a configuration bug that must not wait for traffic
 * to surface.
 */
export async function assembleTools<TMeta>(
  options: ToolOptions<TMeta> | undefined,
): Promise<AssembledTools<TMeta>> {
  const specs: ToolSpec<TMeta>[] = [
    ...resolveCommonTools(options?.common ?? []),
    ...(options?.specs ?? []),
  ];

  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.name)) {
      throw new Error(`Duplicate tool name "${spec.name}" in AgentConfig.`);
    }
    seen.add(spec.name);
  }

  const servers = options?.mcp ?? [];
  const mcp = servers.length > 0 ? await createMcpToolset(servers) : undefined;

  for (const definition of mcp?.definitions ?? []) {
    const name = definition.function.name;
    if (seen.has(name)) {
      await mcp?.close();
      throw new Error(`Duplicate tool name "${name}" from an MCP server.`);
    }
    seen.add(name);
  }

  return {
    specs,
    definitions: [
      ...specs.map((spec) => spec.definitions),
      ...(mcp?.definitions ?? []),
    ],
    mcp,
  };
}

/** Per-turn handler bindings: `userId`, conversation scope and `meta`. */
export function bindTools<TMeta>(
  specs: readonly ToolSpec<TMeta>[],
  ctx: { userId: string; conversationId?: number; meta?: TMeta },
): ReturnType<typeof buildToolRegistry> {
  return buildToolRegistry(ctx, specs);
}
