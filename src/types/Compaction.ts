import { ChatCompletionMessageParam } from "openai/resources";
import { MessageTrace } from "../db/schema";

export interface Compaction {
  temperature: number;
  maxTokens: number;
  /**
   * Estimated history size, in tokens, above which the oldest messages are folded into
   * the rolling summary. Measured against summary + every message above the watermark.
   * Below it the summariser is not called at all. Excludes the system prompt and the
   * incoming user message, so leave room for them in `reserveTokens`.
   */
  tokenThreshold: number;
  /**
   * How many MESSAGES to keep verbatim after the summary. Stored history is user and
   * assistant only, so 30 means 15 exchanges. Raising it costs prefill on every turn;
   * lowering it means the model re-reads more of the conversation through the summary.
   */
  keepRecentMessages: number;
  /**
   * Additional headroom, in tokens, reserved for what is appended AFTER compaction runs:
   * tool results during the loop, plus the final answer. Without this a conversation
   * compacted to exactly `tokenThreshold` can still overflow mid-loop.
   */
  reserveTokens?: number;
}

/** One stored message, with the id the watermark is expressed in. */
export interface HistoryMessage {
  id: number;
  role: "user" | "assistant";
  message: string;
  /** Tool/reasoning trace captured for assistant turns; replayed as real tool turns. */
  trace?: MessageTrace | null;
}

/** Durable compaction state, stored on the conversation row. */
export interface CompactionState {
  /** Rolling summary of everything at or below `throughMessageId`. Null if never compacted. */
  summary: string | null;
  /** Highest messages.id already folded into `summary`. Null if never compacted. */
  throughMessageId: number | null;
}

/** What the caller should persist to the conversation row. */
export interface CompactionUpdate extends CompactionState {
  /** True when this turn produced a new summary that must be written back. */
  changed: boolean;
}

export interface CompactionOutcome {
  /** Messages to send to the model, summary first. */
  messages: ChatCompletionMessageParam[];
  /** Estimated tokens for those messages, for logging and threshold tuning. */
  estimatedTokens: number;
  /** State to persist. `changed` is false when nothing was folded. */
  update: CompactionUpdate;
}
