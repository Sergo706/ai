import type { ChatCompletionMessageParam } from "openai/resources";
import type { MessageTrace } from "../db/schema";

/** Thresholds that decide when old messages are folded into a summary. */
export interface Compaction {
  /** Sampling temperature for the summarisation call. */
  temperature: number;
  /** Token cap for the summarisation call. */
  maxTokens: number;
  /**
   * Estimated history size, in tokens, above which old messages are summarised.
   *
   * Measured over the summary plus every message above the watermark; below it
   * the summariser is never called. The system prompt and the incoming message
   * are not counted, so leave room for them in `reserveTokens`.
   */
  tokenThreshold: number;
  /**
   * How many messages to keep verbatim after the summary.
   *
   * Stored history holds user and assistant turns only, so `30` means 15
   * exchanges. Raising it costs prefill on every turn; lowering it means the
   * model reads more of the conversation only through the summary.
   */
  keepRecentMessages: number;
  /**
   * Extra headroom, in tokens, for what is appended after compaction: tool
   * results during the loop, plus the final answer.
   */
  reserveTokens?: number;
}

/** One stored message, with the id the watermark is expressed in. */
export interface HistoryMessage {
  /** `messages.id` of this turn. */
  id: number;
  /** Who said it. */
  role: "user" | "assistant";
  /** The message text. */
  message: string;
  /** Trace captured for assistant turns; replayed as real tool turns. */
  trace?: MessageTrace | null;
}

/** Durable compaction state, stored on the conversation row. */
export interface CompactionState {
  /** Rolling summary of everything at or below `throughMessageId`. */
  summary: string | null;
  /** Highest `messages.id` already folded into `summary`; `null` if never compacted. */
  throughMessageId: number | null;
}

/** What the caller should persist to the conversation row. */
export interface CompactionUpdate extends CompactionState {
  /** `true` when this turn produced a new summary that must be written back. */
  changed: boolean;
}

/** What one compaction pass produced. */
export interface CompactionOutcome {
  /** Messages to send to the model, summary first. */
  messages: ChatCompletionMessageParam[];
  /** Estimated tokens for those messages, for logging and threshold tuning. */
  estimatedTokens: number;
  /** State to persist. `changed` is `false` when nothing was folded. */
  update: CompactionUpdate;
}
