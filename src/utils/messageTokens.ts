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

export function estimateTextTokens(text: string, CHARS_PER_TOKEN_ESTIMATE: number): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}
