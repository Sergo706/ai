/**
 * Agent API: build one reusable agent and run turns against it.
 *
 * @example
 * ```ts
 * import { createAgent } from "@riavzon/ai/agents";
 *
 * const agent = await createAgent({
 *   model: { model: "gpt-4o-mini" },
 *   systemInstructions: "You are concise.",
 * });
 *
 * const { text } = await agent.complete({ message: "Hi" });
 * ```
 */
export { createAgent } from "./createAgent";
export { composeMessages } from "./composeMessages";
export type {
  Agent,
  AgentConfig,
  AttachmentOptions,
  ChatInput,
  ChatStream,
  ChatTurnResult,
  CompactionOptions,
  ConversationOptions,
  EmbeddingOptions,
  JsonChatInput,
  JsonOptions,
  ModelOptions,
  ModelRequestOptions,
  RunOptions,
  SemanticCacheOptions,
  ToolOptions,
} from "./types";
export type { CommonToolEntry, CommonTools } from "../tools/common-tools-handlers/specs";
