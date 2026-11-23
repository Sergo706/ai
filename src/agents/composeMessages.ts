import type { ChatCompletionMessageParam } from "openai/resources";

/**
 * Builds the message list for one turn: system instructions, then history, then
 * the new ask.
 *
 *
 * The system prompt is composed per turn rather than stored, because the user
 * context (locale, timezone, clock) changes between turns on one conversation.
 *
 * @param args.systemInstructions - The agent's identity, written once.
 * @param args.userContext - Pre-formatted context lines, or `""` for none.
 * @param args.history - Already-converted and compacted history.
 * @param args.message - The user's message for this turn, with any file content
 * already inlined.
 * @returns Provider-ready messages, ready to send as-is.
 *
 * @example
 * ```ts
 * const messages = composeMessages({
 *   systemInstructions: "You are concise.",
 *   userContext: "",
 *   history: [],
 *   message: "Hi",
 * });
 * ```
 */
export function composeMessages(args: {
  systemInstructions: string;
  userContext: string;
  history: readonly ChatCompletionMessageParam[];
  message: string;
}): ChatCompletionMessageParam[] {
  return [
    {
      role: "system",
      content: `${args.systemInstructions}${args.userContext}`,
    },
    ...args.history,
    { role: "user", content: args.message },
  ];
}
