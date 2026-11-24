import type { ChatCompletionMessageParam } from "openai/resources";
import { estimateMessagesTokens } from "../utils/messageTokens";
import { Compaction, CompactionOutcome, CompactionState, HistoryMessage } from "../types/Compaction";


/** No compaction has ever run for this conversation. */
export const EMPTY_COMPACTION_STATE: CompactionState = {
  summary: null,
  throughMessageId: null,
};

function toMessage(message: HistoryMessage): ChatCompletionMessageParam {
  return { role: message.role, content: message.message };
}

/**
 * One stored message as provider messages.
 *
 * An assistant message that called tools expands into the call plus one `tool`
 * message per step, so a replay still matches the recorded trace.
 *
 * @param message - One stored turn.
 * @returns Provider messages for that turn, in order.
 */
export function historyToMessages(
  message: HistoryMessage,
): ChatCompletionMessageParam[] {
  if (message.role !== "assistant") return [toMessage(message)];

  const steps = message.trace?.steps ?? [];
  if (steps.length === 0) return [toMessage(message)];

  return [
    {
      role: "assistant",
      content: null,
      tool_calls: steps.map((step) => ({
        id: step.id,
        type: "function" as const,
        function: {
          name: step.name,
          arguments: JSON.stringify(step.args ?? {}),
        },
      })),
    },
    ...steps.map((step): ChatCompletionMessageParam => ({
      role: "tool",
      tool_call_id: step.id,
      content: step.result,
    })),
    { role: "assistant", content: message.message },
  ];
}

function summaryMessage(summary: string | null): ChatCompletionMessageParam[] {
  if (!summary) return [];
  return [
    {
      role: "system",
      content: `[System Note: Earlier conversation summary: ${summary}]`,
    },
  ];
}

function buildSummaryPrompt(
  previousSummary: string | null,
  messages: HistoryMessage[],
): string {
  const transcript = messages
    .map((m) => `${m.role}: ${m.message}`)
    .join("\n\n");

  const carryOver = previousSummary
    ? `Existing summary of the conversation so far:\n${previousSummary}\n\n`
    : "";

  return (
    carryOver +
    `Merge the existing summary (if any) with the new conversation excerpt below ` +
    `into one concise, factual summary of the entire conversation.\n` +
    `- Preserve key facts, figures and decisions\n` +
    `- Preserve user preferences and constraints\n` +
    `- Preserve open requests and established context\n` +
    `- Do not include pleasantries\n` +
    `- Do not invent anything that is not in the text\n\n` +
    `New conversation excerpt:\n${transcript}`
  );
}

/**
 * Fold older messages into the rolling summary when the history grows too long.
 *
 * Keeps the newest `keepRecentMessages` verbatim and summarises whatever would
 * push the history past `tokenThreshold`. Returns the messages untouched when
 * the history already fits.
 *
 * @param history - The conversation so far, oldest first.
 * @param state - Where the previous summary ended.
 * @param compaction - Thresholds and how many messages to keep.
 * @param summarize - Performs the summary call, so the caller owns the model.
 * @returns The messages to send, the estimated tokens, and the new watermark.
 */
export async function compactHistory(
  history: HistoryMessage[],
  state: CompactionState,
  compaction: Compaction,
  summarize: (prompt: string) => Promise<string>,
): Promise<CompactionOutcome> {
  const { keepRecentMessages, tokenThreshold } = compaction;

  const budget = Math.max(0, tokenThreshold - (compaction.reserveTokens ?? 0));
  const watermark = state.throughMessageId ?? Number.NEGATIVE_INFINITY;
  const pending = history.filter((m) => m.id > watermark);

  const keepCount = Math.max(0, Math.floor(keepRecentMessages));
  const recent = keepCount > 0 ? pending.slice(-keepCount) : [];
  const older = pending.slice(0, pending.length - recent.length);

  const current: ChatCompletionMessageParam[] = [
    ...summaryMessage(state.summary),
    ...pending.flatMap(historyToMessages),
  ];
  const estimatedTokens = estimateMessagesTokens(current);

  if (estimatedTokens <= budget || older.length === 0) {
    return {
      messages: current,
      estimatedTokens,
      update: { ...state, changed: false },
    };
  }

  const summary = await summarize(buildSummaryPrompt(state.summary, older));
  const throughMessageId = older[older.length - 1].id;

  const compacted: ChatCompletionMessageParam[] = [
    ...summaryMessage(summary),
    ...recent.flatMap(historyToMessages),
  ];

  return {
    messages: compacted,
    estimatedTokens: estimateMessagesTokens(compacted),
    update: { summary, throughMessageId, changed: true },
  };
}
