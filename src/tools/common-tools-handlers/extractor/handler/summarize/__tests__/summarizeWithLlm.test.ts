import OpenAI from "openai";
import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "~~/test/test-utils/config";
import { chatCompletion, createFakeLlm } from "~~/test/test-utils/llm";
import { makeSpyLogger } from "~~/test/test-utils/logger";

/**
 * Real summarisation policy, real prompt builders.
 *
 * Only `chat.completions.create` is faked: the transport is the one layer that
 * cannot run offline. Everything asserted here is our own decision — whether
 * the model is called at all, which model/length/token budget goes out, and
 * what happens when the model answers with nothing.
 */

type SummaryModule = typeof import("../summarizeWithLlm.js");

interface Harness {
  summarizeWithLlm: SummaryModule["summarizeWithLlm"];
  withLlmSummary: SummaryModule["withLlmSummary"];
  ContentTooShortError: typeof import("../summarizeErrors.js").ContentTooShortError;
  cleanup: () => Promise<void>;
}

const log = makeSpyLogger();

/**
 * The config schema validates `openAiConfig` with `z.instanceof(OpenAI)`, so a
 * plain object cannot be injected. A real client is constructed — it never
 * dials, because `create` is replaced — and only its transport method is the
 * fake.
 */
function stubOpenAi(create: (...args: never[]) => Promise<unknown>): OpenAI {
  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: "http://127.0.0.1:1/v1",
  });
  Object.assign(client.chat.completions, { create });
  return client;
}

/**
 * `summarizeWithLlm` reads the model, temperature and threshold from the
 * process-wide configuration at call time, so the module has to be imported
 * *after* the configuration exists. Modules imported at file scope would bind
 * to whichever config module was live when the file was evaluated and would
 * then dial the real network.
 */
const DEFAULT_TEST_MODEL = "gpt-4o-mini";

async function boot(
  llm: ReturnType<typeof createFakeLlm>,
  extractor: Record<string, unknown> = { llmModel: DEFAULT_TEST_MODEL },
): Promise<Harness> {
  const env = await loadConfig({
    overrides: {
      openAiConfig: stubOpenAi(llm.client.chat.completions.create),
      extractor,
    },
  });
  const mod = (await import("../summarizeWithLlm.js"));
  const errors = await import("../summarizeErrors.js");

  return {
    summarizeWithLlm: mod.summarizeWithLlm,
    withLlmSummary: mod.withLlmSummary,
    ContentTooShortError: errors.ContentTooShortError,
    cleanup: env.cleanup,
  };
}

function extraction(
  overrides: Partial<import("../types.js").SummarizeExtraction> = {},
): import("../types.js").SummarizeExtraction {
  const content = overrides.content ?? "c".repeat(10_000);
  return {
    url: "https://example.com/article",
    title: "An article",
    content,
    description: "A description",
    siteName: "Example",
    wordCount: 1_500,
    truncated: false,
    fromTranscript: false,
    transcriptSource: null,
    videoUrl: null,
    characters: content.length,
    raw: {} as import("../types.js").SummarizeExtraction["raw"],
    ...overrides,
  };
}

beforeEach(() => {
  log.spies.debug.mockReset();
  log.spies.info.mockReset();
  log.spies.warn.mockReset();
  log.spies.error.mockReset();
});

describe("summarizeWithLlm", () => {
  it("throws on a blank body instead of calling the model", async () => {
    const llm = createFakeLlm(chatCompletion("unused"));
    const env = await boot(llm);

    try {
      await expect(
        env.summarizeWithLlm(extraction({ content: "   " }), log.logger),
      ).rejects.toBeInstanceOf(env.ContentTooShortError);
      expect(llm.calls).toHaveLength(0);
    } finally {
      await env.cleanup();
    }
  });

  it("reports the failing url and minimum on the too-short error", async () => {
    const llm = createFakeLlm(chatCompletion("unused"));
    const env = await boot(llm);

    try {
      const error = await env
        .summarizeWithLlm(
          extraction({ url: "https://example.com/blank", content: "" }),
          log.logger,
        )
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(env.ContentTooShortError);
      const short = error as InstanceType<Harness["ContentTooShortError"]>;
      expect(short.url).toBe("https://example.com/blank");
      expect(short.characters).toBe(0);
      expect(short.minimum).toBe(1);
    } finally {
      await env.cleanup();
    }
  });

  it("passes short bodies through without a model call", async () => {
    const llm = createFakeLlm(chatCompletion("unused"));
    const env = await boot(llm);
    const body = "short but usable";

    try {
      const result = await env.summarizeWithLlm(
        extraction({ content: body }),
        log.logger,
        { minCharactersToSummarize: 1_000 },
      );

      expect(result).toEqual({
        summary: body,
        length: "medium",
        passthrough: true,
        model: DEFAULT_TEST_MODEL,
      });
      expect(llm.calls).toHaveLength(0);
      // The passthrough is logged so an operator can see why no tokens were
      // spent.
      expect(log.spies.debug).toHaveBeenCalledTimes(1);
    } finally {
      await env.cleanup();
    }
  });

  it("summarises long bodies", async () => {
    const llm = createFakeLlm(chatCompletion("A condensed summary."));
    const env = await boot(llm);

    try {
      const result = await env.summarizeWithLlm(extraction(), log.logger);

      expect(result).toEqual({
        summary: "A condensed summary.",
        length: "medium",
        passthrough: false,
        model: DEFAULT_TEST_MODEL,
      });
      expect(llm.calls).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  });

  it("throws a clear error when neither config.extractor.llmModel nor options.model is configured", async () => {
    const llm = createFakeLlm(chatCompletion("unused"));
    const env = await boot(llm, {});

    try {
      await expect(
        env.summarizeWithLlm(extraction(), log.logger),
      ).rejects.toThrow(
        "LLM summarization requires config.extractor.llmModel or options.model to be configured.",
      );
      expect(llm.calls).toHaveLength(0);
    } finally {
      await env.cleanup();
    }
  });

  it("accepts a per-call model override even when config.extractor.llmModel is unset", async () => {
    const llm = createFakeLlm(chatCompletion("Per-call summary."));
    const env = await boot(llm, {});

    try {
      const result = await env.summarizeWithLlm(extraction(), log.logger, {
        model: "claude-sonnet-4",
      });

      expect(result.model).toBe("claude-sonnet-4");
      expect(result.summary).toBe("Per-call summary.");
      expect(llm.calls[0]?.model).toBe("claude-sonnet-4");
    } finally {
      await env.cleanup();
    }
  });

  it("uses the configured threshold instead of the built-in default", async () => {
    const llm = createFakeLlm(chatCompletion("condensed"));
    // A threshold above the body length forces the passthrough branch without
    // the caller passing an option.
    const env = await boot(llm, {
      llmModel: DEFAULT_TEST_MODEL,
      llmMinCharacters: 20_000,
    });

    try {
      const result = await env.summarizeWithLlm(extraction(), log.logger);

      expect(result.passthrough).toBe(true);
      expect(llm.calls).toHaveLength(0);
    } finally {
      await env.cleanup();
    }
  });

  it("lets a per-call threshold win over the configured one", async () => {
    const llm = createFakeLlm(chatCompletion("condensed"));
    const env = await boot(llm, {
      llmModel: DEFAULT_TEST_MODEL,
      llmMinCharacters: 20_000,
    });

    try {
      const result = await env.summarizeWithLlm(extraction(), log.logger, {
        minCharactersToSummarize: 10,
      });

      expect(result.passthrough).toBe(false);
      expect(llm.calls).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  });

  it("requests a token budget that grows with the length preset", async () => {
    const llm = createFakeLlm(chatCompletion("ok"));
    const env = await boot(llm);

    try {
      await env.summarizeWithLlm(extraction(), log.logger, { length: "short" });
      await env.summarizeWithLlm(extraction(), log.logger, {
        length: "xxl",
      });

      const [shortCall, longCall] = llm.calls;
      if (
        shortCall.max_tokens === undefined ||
        longCall.max_tokens === undefined
      ) {
        throw new Error("both calls must carry a token budget");
      }
      expect(shortCall.stream).toBe(false);
      expect(shortCall.model).toBe(DEFAULT_TEST_MODEL);
      expect(shortCall.temperature).toBe(0.2);
      expect(shortCall.max_tokens).toBeGreaterThan(0);
      expect(longCall.max_tokens).toBeGreaterThan(shortCall.max_tokens);
    } finally {
      await env.cleanup();
    }
  });

  it("sends the configured temperature and model", async () => {
    const llm = createFakeLlm(chatCompletion("ok"));
    const env = await boot(llm, {
      llmTemperature: 0.9,
      llmModel: "some-other-model",
    });

    try {
      const result = await env.summarizeWithLlm(extraction(), log.logger);

      expect(llm.calls[0].model).toBe("some-other-model");
      expect(llm.calls[0].temperature).toBe(0.9);
      expect(result.model).toBe("some-other-model");
    } finally {
      await env.cleanup();
    }
  });

  it("sends the shared system prompt and a user prompt mentioning the URL", async () => {
    const llm = createFakeLlm(chatCompletion("ok"));
    const env = await boot(llm);

    try {
      await env.summarizeWithLlm(extraction(), log.logger);

      const messages = llm.calls[0].messages;
      expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(String(messages[0].content).length).toBeGreaterThan(20);
      expect(String(messages[1].content)).toContain(
        "https://example.com/article",
      );
      expect(String(messages[1].content)).toContain("An article");
    } finally {
      await env.cleanup();
    }
  });

  it("forwards a prompt override into the user prompt", async () => {
    const llm = createFakeLlm(chatCompletion("ok"));
    const env = await boot(llm);

    try {
      await env.summarizeWithLlm(extraction(), log.logger, {
        promptOverride: "focus on the pricing table",
      });

      expect(String(llm.calls[0].messages[1].content)).toContain(
        "focus on the pricing table",
      );
    } finally {
      await env.cleanup();
    }
  });

  it("tells the prompt that the body came from a transcript", async () => {
    const llm = createFakeLlm(chatCompletion("ok"));
    const env = await boot(llm);

    try {
      await env.summarizeWithLlm(
        extraction({ fromTranscript: true, transcriptSource: "yt-dlp" }),
        log.logger,
      );
      const withTranscript = String(llm.calls[0].messages[1].content);

      const plain = createFakeLlm(chatCompletion("ok"));
      const env2 = await boot(plain);
      try {
        await env2.summarizeWithLlm(extraction(), log.logger);
        // `hasTranscript` changes the instructions, so the two prompts must not
        // be byte-identical.
        expect(String(plain.calls[0].messages[1].content)).not.toBe(
          withTranscript,
        );
      } finally {
        await env2.cleanup();
      }
    } finally {
      await env.cleanup();
    }
  });

  it("ignores an unknown length and falls back to the default", async () => {
    const llm = createFakeLlm(chatCompletion("ok"));
    const env = await boot(llm);

    try {
      const result = await env.summarizeWithLlm(extraction(), log.logger, {
        length: "gigantic" as never,
      });

      expect(result.length).toBe("medium");
    } finally {
      await env.cleanup();
    }
  });

  it("keeps the extracted body when the model returns nothing", async () => {
    const llm = createFakeLlm({ choices: [{ message: { content: null } }] });
    const env = await boot(llm);

    try {
      const result = await env.summarizeWithLlm(extraction(), log.logger);

      expect(result.passthrough).toBe(true);
      expect(result.summary).toHaveLength(10_000);
      expect(log.spies.warn).toHaveBeenCalledTimes(1);
    } finally {
      await env.cleanup();
    }
  });

  it("keeps the extracted body when the model returns whitespace", async () => {
    const llm = createFakeLlm(chatCompletion("   \n  "));
    const env = await boot(llm);

    try {
      const result = await env.summarizeWithLlm(extraction(), log.logger);

      expect(result.passthrough).toBe(true);
      expect(result.summary).toHaveLength(10_000);
    } finally {
      await env.cleanup();
    }
  });

  it("keeps the extracted body when the response has no choices", async () => {
    const llm = createFakeLlm({ choices: [] });
    const env = await boot(llm);

    try {
      const result = await env.summarizeWithLlm(extraction(), log.logger);

      expect(result.passthrough).toBe(true);
      expect(result.summary).toHaveLength(10_000);
    } finally {
      await env.cleanup();
    }
  });

  it("trims the model answer", async () => {
    const llm = createFakeLlm(chatCompletion("  padded summary  \n"));
    const env = await boot(llm);

    try {
      const result = await env.summarizeWithLlm(extraction(), log.logger);

      expect(result.summary).toBe("padded summary");
    } finally {
      await env.cleanup();
    }
  });

  it("propagates transport failures", async () => {
    const llm = createFakeLlm(chatCompletion("never"));
    const failure = new Error("upstream 503");
    llm.failNext(failure);
    const env = await boot(llm);

    try {
      await expect(
        env.summarizeWithLlm(extraction(), log.logger),
      ).rejects.toBe(failure);
    } finally {
      await env.cleanup();
    }
  });
});

describe("withLlmSummary", () => {
  it("replaces the body but keeps the metadata", async () => {
    const llm = createFakeLlm(chatCompletion("Condensed."));
    const env = await boot(llm);

    try {
      const original = extraction();
      const result = await env.withLlmSummary(original, log.logger);

      expect(result.content).toBe("Condensed.");
      expect(result.characters).toBe(10);
      expect(result.title).toBe(original.title);
      expect(result.fromTranscript).toBe(original.fromTranscript);
      expect(result.summary.summary).toBe("Condensed.");
    } finally {
      await env.cleanup();
    }
  });

  it("leaves characters consistent with the replaced body", async () => {
    const llm = createFakeLlm(chatCompletion("abc"));
    const env = await boot(llm);

    try {
      const result = await env.withLlmSummary(extraction(), log.logger);

      expect(result.characters).toBe(result.content.length);
      expect(result.characters).toBe(3);
    } finally {
      await env.cleanup();
    }
  });

  it("propagates a too-short body without rewriting the extraction", async () => {
    const llm = createFakeLlm(chatCompletion("unused"));
    const env = await boot(llm);

    try {
      await expect(
        env.withLlmSummary(extraction({ content: "  " }), log.logger),
      ).rejects.toBeInstanceOf(env.ContentTooShortError);
    } finally {
      await env.cleanup();
    }
  });
});
