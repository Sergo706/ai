import { buildAgent } from "./agent";
import type { Agent, AgentConfig } from "./types";

/**
 * Builds one reusable agent.
 *
 * Everything static happens here — tool specs, provider definitions, MCP
 * connections, config validation — so a misconfiguration fails at construction
 * rather than on the first request. Everything per-turn happens inside `chat`.
 *
 * @param config - The agent's identity, model, tools and optional subsystems.
 * @returns A ready agent. Call `close()` to release its MCP connections.
 * @throws If `runs` or `compaction` is set without a persisted conversation, or
 * if two tool sources claim the same tool name.
 *
 * @example
 * ```ts
 * const agent = await createAgent({
 *   model: { model: "gpt-4o-mini" },
 *   systemInstructions: "You are concise.",
 *   conversation: { persist: true },
 * });
 *
 * const { text } = await agent.complete({ message: "Hi", userId: "u_1" });
 * await agent.close();
 * ```
 */
export async function createAgent<TMeta = unknown>(
  config: AgentConfig<TMeta>,
): Promise<Agent<TMeta>> {
  return buildAgent(config);
}
