import type { ChatCompletionMessageParam } from "openai/resources";

function partText(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join(" ");
  }

  return "";
}

function countNonTextParts(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (part) => !(part && typeof part === "object" && "text" in part),
  ).length;
}

/**
 * Estimate the token cost of one chat message.
 *
 * Counts text content, tool calls, non-text parts, and the per-message overhead
 * a provider adds.
 *
 * @param message - The message to measure.
 * @param MESSAGE_OVERHEAD_TOKENS - Role header and separators per message.
 * @default MESSAGE_OVERHEAD_TOKENS 4
 * @param CHARS_PER_TOKEN - Characters per token for the estimate.
 * @default CHARS_PER_TOKEN 3.6
 * @param NON_TEXT_PART_TOKENS - Stand-in for an image or audio part.
 * @default NON_TEXT_PART_TOKENS 85
 * @returns The estimated token count.
 */
export function estimateMessageTokens(
  message: ChatCompletionMessageParam,
  /** Role header and separators a provider adds per message. */
  MESSAGE_OVERHEAD_TOKENS = 4,
  /** Rough characters per token for English prose. Real tokenizers sit near 4. */
  CHARS_PER_TOKEN = 3.6,
  /** A structured content part that is not text (image, audio) has no char count. */
  NON_TEXT_PART_TOKENS = 85,
): number {
  const record = message as unknown as Record<string, unknown>;

  let chars = partText(record.content).length;
  chars += countNonTextParts(record.content) * NON_TEXT_PART_TOKENS * 3;

  if (Array.isArray(record.tool_calls)) {
    for (const call of record.tool_calls) {
      const fn = (call as { function?: { name?: string; arguments?: string } })
        .function;
      chars += (fn?.name?.length ?? 0) + (fn?.arguments?.length ?? 8);
    }
  }

  if (typeof record.name === "string") chars += record.name.length;

  return Math.ceil(chars / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;
}

/**
 * Estimate the token cost of a message list.
 *
 * The sum of {@link estimateMessageTokens} over `messages`.
 *
 * @param messages - The messages to measure.
 * @param MESSAGE_OVERHEAD_TOKENS - Role header and separators per message.
 * @default MESSAGE_OVERHEAD_TOKENS 4
 * @param CHARS_PER_TOKEN - Characters per token for the estimate.
 * @default CHARS_PER_TOKEN 3.6
 * @param NON_TEXT_PART_TOKENS - Stand-in for an image or audio part.
 * @default NON_TEXT_PART_TOKENS 85
 * @returns The estimated token count.
 * @example
 * ```ts
 * if (estimateMessagesTokens(messages) > 8000) await compact(messages);
 * ```
 */
export function estimateMessagesTokens(
  messages: readonly ChatCompletionMessageParam[],
  /** Role header and separators a provider adds per message. */
  MESSAGE_OVERHEAD_TOKENS = 4,
  /** Rough characters per token for English prose. Real tokenizers sit near 4. */
  CHARS_PER_TOKEN = 3.6,
  /** A structured content part that is not text (image, audio) has no char count. */
  NON_TEXT_PART_TOKENS = 85,
): number {
  return messages.reduce(
    (sum, message) =>
      sum +
      estimateMessageTokens(
        message,
        MESSAGE_OVERHEAD_TOKENS,
        CHARS_PER_TOKEN,
        NON_TEXT_PART_TOKENS,
      ),
    0,
  );
}

/**
 * Estimate tokens for plain text from its length.
 *
 * @param text - The text to measure.
 * @param CHARS_PER_TOKEN_ESTIMATE - Characters per token.
 * @returns The estimated token count, rounded up.
 */
export function estimateTextTokens(
  text: string,
  CHARS_PER_TOKEN_ESTIMATE: number,
): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}
