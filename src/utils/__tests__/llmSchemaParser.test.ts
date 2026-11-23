import { describe, expect, it } from "vitest";
import { z } from "zod";

import { makeSpyLogger } from "~~/test/test-utils/logger";
import {
  chatCompletion,
  createFakeLlm,
  emptyCompletion,
  lastMessage,
  messageContent,
  type CapturedChatCall,
  type ChatCompletionLike,
} from "~~/test/test-utils/llm";
import { llmSchemaParser } from "../llmSchemaParser.js";
import type { ParserConfig, RetryRequest } from "../types/SchemaParser.js";

/**
 * `llmSchemaParser` is the repair loop between a model and a zod schema.
 *
 * It had no dedicated suite: `agentTurns.test.ts` exercises it only through
 * `runJsonTurn`, which reaches the happy path and a single repair. Every failure
 * classification below — no choices, a refusal, a truncated finish, an empty
 * answer, invalid JSON, a schema that cannot render as a strict response format —
 * is a branch the caller depends on to report something accurate, so each one is
 * asserted on its message and on the log line it produces.
 */

const schema = z.object({ answer: z.string() });
const valid = JSON.stringify({ answer: "forty two" });

/**
 * The nth captured retry request.
 *
 * `noUncheckedIndexedAccess` is off in this project, so a plain `calls[index]`
 * is typed as present and a guard would be flagged as dead code. `at()` returns
 * `undefined` for a missing index under either setting, which keeps the failure
 * mode explicit: if the parser stopped retrying, this throws rather than letting
 * `undefined` reach an assertion.
 */
function callAt(calls: readonly CapturedChatCall[], index: number) {
  const call = calls.at(index);
  if (call === undefined) {
    throw new Error(`No retry request was recorded at index ${String(index)}`);
  }
  return call;
}

/** The parser config with a retry that records what it was asked to send. */
function configs(overrides: Partial<ParserConfig> = {}): ParserConfig {
  const llm = createFakeLlm(chatCompletion(valid));
  return {
    agent: "test",
    messages: [{ role: "user", content: "hi" }],
    retry: (request) => llm.client.chat.completions.create(request) as never,
    ...overrides,
  };
}

describe("llmSchemaParser", () => {
  it("returns the parsed value and logs the attempt that succeeded", async () => {
    const { logger, spies } = makeSpyLogger();

    const result = await llmSchemaParser(
      schema,
      chatCompletion(valid) as never,
      configs(),
      logger,
    );

    expect(result).toEqual({ answer: "forty two" });
    expect(spies.debug).toHaveBeenCalledWith(
      { attempt: 1, retriesUsed: 0, elapsedMs: expect.any(Number) },
      "LLM response validated successfully",
    );
    // The first attempt is described before it is evaluated, so operators can
    // see which response id failed without reading the payload.
    expect(spies.debug).toHaveBeenCalledWith(
      {
        attempt: 1,
        maxAttempts: 3,
        responseId: "chatcmpl-test",
        model: "deepseek-flash",
        finishReason: "stop",
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      },
      "Validating LLM response",
    );
  });

  it("falls back to the console logger when none is given", async () => {
    // The `logger ?? console` default is what keeps the function usable outside
    // the agent, so it must not throw on the shape `console` provides.
    await expect(
      llmSchemaParser(schema, chatCompletion(valid) as never, configs()),
    ).resolves.toEqual({ answer: "forty two" });
  });

  it("strips thinking and code fences before parsing", async () => {
    const content = "```json\n<think>hmm</think>\n" + valid + "\n```";

    const result = await llmSchemaParser(
      schema,
      chatCompletion(content) as never,
      configs(),
    );

    expect(result).toEqual({ answer: "forty two" });
  });

  it("rejects a maxRetries that is not a non-negative integer", async () => {
    const { logger, spies } = makeSpyLogger();

    await expect(
      llmSchemaParser(
        schema,
        chatCompletion(valid) as never,
        configs({ maxRetries: 1.5 }),
        logger,
      ),
    ).rejects.toThrow("maxRetries must be a non-negative integer");
    expect(spies.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Invalid parser configuration",
    );

    await expect(
      llmSchemaParser(
        schema,
        chatCompletion(valid) as never,
        configs({ maxRetries: -1 }),
        logger,
      ),
    ).rejects.toThrow("maxRetries must be a non-negative integer");
  });

  it("rejects a negative maxRetries even though it is an integer", async () => {
    await expect(
      llmSchemaParser(
        schema,
        chatCompletion(valid) as never,
        configs({ maxRetries: -3 }),
      ),
    ).rejects.toThrow("maxRetries must be a non-negative integer");
  });

  it("throws when the model returns no choices", async () => {
    const { logger, spies } = makeSpyLogger();

    await expect(
      llmSchemaParser(schema, emptyCompletion() as never, configs(), logger),
    ).rejects.toThrow("Model returned no choices");
    // No choice is not retryable: the answer will not appear on a second call.
    expect(spies.error).toHaveBeenCalledWith(
      { err: expect.any(Error), attempt: 1 },
      "LLM response cannot be parsed",
    );
  });

  it("throws when the model refuses", async () => {
    await expect(
      llmSchemaParser(
        schema,
        chatCompletion("", { refusal: "I cannot help with that" }) as never,
        configs(),
      ),
    ).rejects.toThrow("Model refused the request");
  });

  it("names the finish reason when the model stops early", async () => {
    await expect(
      llmSchemaParser(
        schema,
        chatCompletion(valid, { finishReason: "length" }) as never,
        configs(),
      ),
    ).rejects.toThrow("Model did not finish normally: length");
  });

  it("repairs a non-string content by asking again with the failure", async () => {
    const llm = createFakeLlm(chatCompletion(valid));
    const retry = (request: RetryRequest) =>
      llm.client.chat.completions.create(request) as never;

    const blank: ChatCompletionLike = chatCompletion(valid);
    const firstChoice = blank.choices[0];
    (firstChoice.message as { content: unknown }).content = null;

    const result = await llmSchemaParser(
      schema,
      blank as never,
      configs({ retry }),
    );

    expect(result).toEqual({ answer: "forty two" });
    const correction = callAt(llm.calls, 0);
    // The failed answer is not echoed back when there was nothing to echo.
    expect(correction.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(lastMessage(correction)).toContain(
      "Validation errors: Model returned no textual answer",
    );
  });

  it("reports an answer that was entirely thinking as empty after cleaning", async () => {
    const llm = createFakeLlm(chatCompletion(valid));
    const parser = llmSchemaParser(
      schema,
      chatCompletion("<think>only thoughts</think>") as never,
      configs({
        retry: (request) =>
          llm.client.chat.completions.create(request as never) as never,
      }),
    );

    await expect(parser).resolves.toEqual({ answer: "forty two" });
    expect(lastMessage(llm.calls[0])).toContain(
      "Validation errors: Model returned no final answer",
    );
  });

  it("classifies invalid JSON as a syntax problem rather than echoing it", async () => {
    const llm = createFakeLlm(chatCompletion(valid));

    await llmSchemaParser(
      schema,
      chatCompletion("{not json at all") as never,
      configs({
        retry: (request) =>
          llm.client.chat.completions.create(request as never) as never,
      }),
    );

    const correction = callAt(llm.calls, 0);
    expect(lastMessage(correction)).toContain(
      "Validation errors: Response is not valid JSON.",
    );
    // The bad text is echoed as the assistant turn so the model can see what it
    // said; only the *feedback* is replaced by the generic message.
    expect(messageContent(correction, "assistant")).toBe("{not json at all");
  });

  it("echoes the zod issues and the schema for a schema-invalid answer", async () => {
    const llm = createFakeLlm(chatCompletion(valid));

    await llmSchemaParser(
      schema,
      chatCompletion(JSON.stringify({ answer: 7 })) as never,
      configs({
        retry: (request) =>
          llm.client.chat.completions.create(request as never) as never,
      }),
    );

    const correction = callAt(llm.calls, 0);
    const feedback = lastMessage(correction);
    expect(feedback).toContain('"path":"answer"');
    expect(feedback).toContain('"code":"invalid_type"');
    // The rendered schema travels in the prompt because providers here reject
    // `json_schema` response formats.
    expect(feedback).toContain('Schema: {"$schema"');
    expect(feedback).toContain('"properties":{"answer":{"type":"string"}}');
    expect(feedback).toContain('"additionalProperties":false');
    expect(correction.response_format).toMatchObject({ type: "json_schema" });
  });

  it("omits the schema from the prompt when asked to", async () => {
    const llm = createFakeLlm(chatCompletion(valid));

    await llmSchemaParser(
      schema,
      chatCompletion(JSON.stringify({ answer: 7 })) as never,
      configs({
        includeSchemaInPrompt: false,
        retry: (request) =>
          llm.client.chat.completions.create(request as never) as never,
      }),
    );


    expect(lastMessage(llm.calls[0])).not.toContain("Schema: ");
    // The response format is still sent; only the prompt copy is suppressed.
    expect(callAt(llm.calls, 0).response_format).toMatchObject({
      type: "json_schema",
    });
  });

  it("renders the schema once and reuses it across repairs", async () => {
    // `createFakeLlm` replays its last entry forever, so the queue is exactly the
    // two retries: the first still invalid, the second the valid answer.
    const llm = createFakeLlm(
      chatCompletion(JSON.stringify({ answer: 8 })),
      chatCompletion(valid),
    );

    const result = await llmSchemaParser(
      schema,
      chatCompletion(JSON.stringify({ answer: 1 })) as never,
      configs({
        retry: (request) =>
          llm.client.chat.completions.create(request as never) as never,
      }),
    );

    expect(result).toEqual({ answer: "forty two" });
    expect(llm.calls).toHaveLength(2);
    // Both corrections carry the same rendered schema, i.e. it was memoised.
    expect(lastMessage(llm.calls[0])).toContain("Schema: {");
    expect(lastMessage(llm.calls[1])).toContain("Schema: {");
  });

  it("still repairs when the schema has no strict response format", async () => {
    // `z.record` has no `additionalProperties: false` form, so
    // `zodResponseFormat` throws. The repair must continue from the prompt.
    const loose = z.record(z.string(), z.string());
    const llm = createFakeLlm(chatCompletion(JSON.stringify({ a: "b" })));
    const { logger, spies } = makeSpyLogger();

    const result = await llmSchemaParser(
      loose,
      chatCompletion(JSON.stringify({ a: 7 })) as never,
      configs({
        retry: (request) =>
          llm.client.chat.completions.create(request as never) as never,
      }),
      logger,
    );

    expect(result).toEqual({ a: "b" });
    expect(spies.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Schema cannot be rendered as a strict response format; the correction prompt carries it instead",
    );
    // No `response_format` at all, and no schema text in the prompt either.
    expect(llm.calls[0]).not.toHaveProperty("response_format");
    expect(lastMessage(llm.calls[0])).not.toContain("Schema: ");
  });

  it("gives up after maxRetries and throws the last failure", async () => {
    const llm = createFakeLlm(chatCompletion("nope"));
    const { logger, spies } = makeSpyLogger();

    await expect(
      llmSchemaParser(
        schema,
        chatCompletion("nope") as never,
        configs({
          maxRetries: 1,
          retry: (request) =>
            llm.client.chat.completions.create(request as never) as never,
        }),
        logger,
      ),
    ).rejects.toThrow(SyntaxError);
    expect(llm.calls).toHaveLength(1);
    expect(spies.error).toHaveBeenCalledWith(
      {
        attempt: 2,
        validationErrors: "Response is not valid JSON.",
        elapsedMs: expect.any(Number),
      },
      "LLM schema repair attempts exhausted",
    );
  });

  it("does not retry when maxRetries is zero", async () => {
    const llm = createFakeLlm(chatCompletion(valid));

    await expect(
      llmSchemaParser(
        schema,
        chatCompletion("nope") as never,
        configs({
          maxRetries: 0,
          retry: (request) =>
            llm.client.chat.completions.create(request as never) as never,
        }),
      ),
    ).rejects.toThrow(SyntaxError);
    expect(llm.calls).toHaveLength(0);
  });

  it("surfaces a repair request failure rather than retrying it", async () => {
    const llm = createFakeLlm(chatCompletion(valid));
    llm.failNext(new Error("provider down"));
    const { logger, spies } = makeSpyLogger();

    await expect(
      llmSchemaParser(
        schema,
        chatCompletion("nope") as never,
        configs({
          retry: (request) =>
            llm.client.chat.completions.create(request as never) as never,
        }),
        logger,
      ),
    ).rejects.toThrow("provider down");
    expect(spies.error).toHaveBeenCalledWith(
      { err: expect.any(Error), retry: 1 },
      "LLM repair request failed",
    );
  });

  it("wraps a thrown non-Error into an Error", async () => {
    // `safeParse` is the only call inside the guarded block a caller can replace,
    // so a schema that throws a bare string exercises the `instanceof Error`
    // fallback that keeps whatever is thrown an Error. Throwing a non-Error is
    // the whole point of the test, hence the rule waiver.
    const exploding = {
      safeParse: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "boom";
      },
    } as unknown as typeof schema;

    const thrown = await llmSchemaParser(
      exploding,
      chatCompletion(valid) as never,
      configs({ maxRetries: 0 }),
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("boom");
  });
});
