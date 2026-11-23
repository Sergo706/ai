import type { ExtractedLinkContent } from "@steipete/summarize-core/content";
import type { SummaryLength } from "@steipete/summarize-core/prompts";
import { getConfiguration } from "../../../../../config/config";

/**
 * Pick the most useful body the library produced.
 *
 * For video URLs `content` can be the caption transcript while `content` for a
 * page is the readability output; preferring the longer of the two (rather than
 * a fixed order) is what makes one code path work for both without branching on
 * URL shape, which the library already did for us.
 */
export function usableContent(extracted: ExtractedLinkContent): {
  text: string;
  fromTranscript: boolean;
} {
  const page = extracted.content.trim();
  const transcript = (extracted.transcriptTimedText ?? "").trim();

  if (transcript.length > page.length) {
    return { text: transcript, fromTranscript: true };
  }

  if (
    transcript.length === 0 &&
    extracted.transcriptSource !== null &&
    page.length > 0
  ) {
    return { text: page, fromTranscript: true };
  }

  return { text: page, fromTranscript: false };
}

/**
 * Trim, treating blank as absent.
 *
 * `||` is wrong here (the linter is right that it is too eager in general) but
 * `??` is wrong the other way: the library returns `""` for a missing `<title>`,
 * and an empty title is not a title. Being explicit keeps both cases correct.
 */
export function trimmedOr<T>(
  value: string | null | undefined,
  fallback: T,
): string | T {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? fallback : trimmed;
}

/** {@link trimmedOr} specialised for the nullable metadata fields. */
export function trimmedOrNull(value: string | null | undefined): string | null {
  return trimmedOr(value, null);
}


const VALID_LENGTHS: readonly SummaryLength[] = [
  "short",
  "medium",
  "long",
  "xl",
  "xxl",
];

/**
 * Resolution order: the call's own choice, then `config.extractor.llmLength`,
 * then `medium`.
 *
 * Deliberately not a module-level constant any more. Reading the config at
 * import time would freeze whatever was configured first, so a second
 * `configuration()` call would be ignored for the life of the process.
 */
export function resolveLength(
  requested: SummaryLength | undefined,
): SummaryLength {
  if (requested && VALID_LENGTHS.includes(requested)) return requested;

  const configured = getConfiguration().extractor?.llmLength ?? "medium";
  return VALID_LENGTHS.find((length) => length === configured) ?? "medium";
}
