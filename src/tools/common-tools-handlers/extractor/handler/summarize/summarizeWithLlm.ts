import { aiClients, getConfiguration } from "../../../../../config/config";
import { loadPeer } from "../../../../../utils/loadPeerDepend";
import type { Logger } from "../../../../../config/configSchema";
import { ContentTooShortError } from "./summarizeErrors";
import type {
  LlmSummary,
  SummarizeExtraction,
  SummarizeWithLlmOptions,
} from "./types";
import { resolveLength } from "./utils";

type PromptsPeer = typeof import("@steipete/summarize-core/prompts");

async function summarizePrompts(): Promise<PromptsPeer> {
  return loadPeer<PromptsPeer>(
    "@steipete/summarize-core/prompts",
    "LLM summarization",
  );
}

/**
 * Condense an already-extracted page with the configured model.
 *
 * Short pages are returned unchanged rather than sent to the model: paying for a
 * round trip that reproduces the input is waste, and a very short body risks the
 * model padding it with invented detail.
 *
 * Threshold, temperature and model come from `config.extractor` so a consumer
 * can tune them without env vars; per-call options still win.
 *
 * @throws {ContentTooShortError} when the input is blank. An empty summary is
 * never useful, so an empty input is a failure rather than a passthrough.
 */
export async function summarizeWithLlm(
  extraction: SummarizeExtraction,
  log: Logger,
  options: SummarizeWithLlmOptions = {},
): Promise<LlmSummary> {
  const content = extraction.content.trim();

  if (content === "") {
    throw new ContentTooShortError(extraction.url, 0, 1);
  }

  const { extractor } = getConfiguration();
  const model = options.model ?? extractor?.llmModel;
  if (!model) {
    throw new Error(
      "LLM summarization requires config.extractor.llmModel or options.model to be configured.",
    );
  }

  const length = resolveLength(options.length);
  const threshold =
    options.minCharactersToSummarize ?? extractor?.llmMinCharacters ?? 4_000;

  if (content.length < threshold) {
    log.debug(
      { url: extraction.url, characters: content.length, threshold },
      "[summarize] Body is short enough to use as-is",
    );
    return { summary: content, length, passthrough: true, model };
  }

  const {
    buildLinkSummaryPrompt,
    SUMMARY_LENGTH_TO_TOKENS,
    SUMMARY_SYSTEM_PROMPT,
  } = await summarizePrompts();

  const prompt = buildLinkSummaryPrompt({
    url: extraction.url,
    title: extraction.title,
    siteName: extraction.siteName,
    description: extraction.description,
    content,
    truncated: extraction.truncated,
    hasTranscript: extraction.fromTranscript,
    hasTranscriptTimestamps: false,
    summaryLength: length,
    shares: [],
    promptOverride: options.promptOverride ?? null,
  });

  const client = aiClients();
  const started = Date.now();

  const response = await client.chat.completions.create({
    model,
    stream: false,
    temperature: extractor?.llmTemperature ?? 0.2,
    max_tokens: SUMMARY_LENGTH_TO_TOKENS[length],
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  });

  const summary = (response.choices[0]?.message.content ?? "").trim();

  if (summary === "") {
    log.warn(
      { url: extraction.url, model, length },
      "[summarize] Model returned an empty summary; keeping the extracted body",
    );
    return {
      summary: content,
      length,
      passthrough: true,
      model,
    };
  }

  log.debug(
    {
      url: extraction.url,
      inputCharacters: content.length,
      outputCharacters: summary.length,
      model,
      length,
      elapsedMs: Date.now() - started,
    },
    "[summarize] Summarised extracted content",
  );

  return { summary, length, passthrough: false, model };
}

/**
 * Summarize in place: returns the extraction with its body replaced.
 *
 * Convenience for callers that want the original metadata (title, transcript
 * source, diagnostics) but the condensed text.
 */
export async function withLlmSummary(
  extraction: SummarizeExtraction,
  log: Logger,
  options: SummarizeWithLlmOptions = {},
): Promise<SummarizeExtraction & { summary: LlmSummary }> {
  const summary = await summarizeWithLlm(extraction, log, options);

  return {
    ...extraction,
    content: summary.summary,
    characters: summary.summary.length,
    summary,
  };
}
