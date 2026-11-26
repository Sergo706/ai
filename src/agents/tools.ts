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
 * Every advertised tool has a matching spec, including MCP tools, so a name the
 * model can see is always a name the loop can run.
 */
export interface AssembledTools<TMeta> {
  specs: readonly ToolSpec<TMeta>[];
  definitions: readonly (ChatCompletionTool | ChatCompletionFunctionTool)[];
  mcp: McpToolset | undefined;
}

/**
 * Builds the agent's tools once, at construction.
 *
 * Three sources are merged: the package's common tools, the host's own specs,
 * and the specs generated for each MCP server. Duplicates are rejected here
 * rather than at call time, so a name the model sees always has one owner.
 *
 * @param options - The agent's {@link ToolOptions}.
 * @returns The merged specs, the definitions to advertise, and the MCP toolset
 * whose connections the agent must close.
 * @throws If two sources claim the same tool name.
 */
export async function assembleTools<TMeta>(
  options: ToolOptions<TMeta> | undefined,
): Promise<AssembledTools<TMeta>> {
  const servers = options?.mcp ?? [];
  const mcp = servers.length > 0 ? await createMcpToolset(servers) : undefined;

  const specs: ToolSpec<TMeta>[] = [
    ...resolveCommonTools(options?.common ?? []),
    ...(options?.specs ?? []),
    ...(mcp?.specs ?? []),
  ];

  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.name)) {
      await mcp?.close();
      throw new Error(`Duplicate tool name "${spec.name}" in AgentConfig.`);
    }
    seen.add(spec.name);
  }

  return {
    specs,
    definitions: specs.map((spec) => spec.definitions),
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
