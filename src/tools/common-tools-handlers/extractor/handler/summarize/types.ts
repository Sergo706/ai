import type {
  ExtractedLinkContent,
  FetchLinkContentOptions,
} from "@steipete/summarize-core/content";
import type { SummaryLength } from "@steipete/summarize-core/prompts";


export interface SummarizeExtraction {
  url: string;
  title: string;
  /** Markdown body. Never empty: a too-short result throws instead. */
  content: string;
  description: string | null;
  siteName: string | null;
  wordCount: number;
  truncated: boolean;
  characters: number;
  /** `true` when the body came from a transcript rather than the page itself. */
  fromTranscript: boolean;
  transcriptSource: ExtractedLinkContent["transcriptSource"];
  videoUrl: string | null;
  /** Raw payload, retained so callers can inspect diagnostics without a refetch. */
  raw: ExtractedLinkContent;
}

/** One URL's outcome. `error` carries why this layer could not use it. */
export type SummarizeOutcome =
  | { url: string; ok: true; value: SummarizeExtraction }
  | { url: string; ok: false; error: unknown };

export interface ExtractOptions extends FetchLinkContentOptions {
  /** Overrides `SUMMARIZE_MIN_CONTENT_CHARACTERS` for one call. */
  minCharacters?: number;
  deadlineMs?: number;
}

export interface LlmSummary {
  /** The condensed body. */
  summary: string;
  /** Which length preset produced it. */
  length: SummaryLength;
  /** True when the input was already short enough and came back untouched. */
  passthrough: boolean;
  model: string;
}

export interface SummarizeWithLlmOptions {
  /** Length preset; defaults to `SUMMARIZE_LLM_LENGTH` (`medium`). */
  length?: SummaryLength;
  /**
   * Skips the model when the body is already below this many characters.
   * Defaults to `SUMMARIZE_LLM_MIN_CHARACTERS`.
   */
  minCharactersToSummarize?: number;
  /** Extra instruction appended to the prompt, e.g. a focus area. */
  promptOverride?: string;
}
