import { z } from "zod";
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { removeCodeFence, removeThinking } from "./removeThink";
import { ParserConfig, SchemaFormat } from "./types/SchemaParser";
import { Logger } from "../config/configSchema";
import { loadPeer } from "./loadPeerDepend";

type OpenAiZodPeer = typeof import("openai/helpers/zod");

let openAiZodModule: OpenAiZodPeer | undefined;

async function openAiZod(): Promise<OpenAiZodPeer> {
  openAiZodModule ??= await loadPeer<OpenAiZodPeer>(
    "openai/helpers/zod",
    "schema-constrained LLM output",
  );
  return openAiZodModule;
}

/**
 * Validate a model reply against a Zod schema, repairing it when needed.
 *
 * Strips thinking blocks and code fences, parses the JSON, and validates it.
 * On failure it re-asks with the validation errors and, when the schema can be
 * rendered strictly, the schema itself.
 *
 * @param schema - The schema the reply must satisfy.
 * @param llmResponse - The completion to validate.
 * @param configs - Messages, retry budget, and the function that performs a
 * repair call.
 * @param logger - Optional logger.
 * @default logger console
 * @returns The validated, typed value.
 * @throws If the reply is empty, was refused, did not finish with `stop`, or no
 * attempt produced valid JSON.
 * @example
 * ```ts
 * const results = await llmSchemaParser(ResultsSchema, completion, {
 *   agent: "extractor",
 *   messages,
 *   retry: (request) => client.chat.completions.create({ model, ...request }),
 * });
 * ```
 */
export async function llmSchemaParser<S extends z.ZodType>(
  schema: S,
  llmResponse: ChatCompletion,
  configs: ParserConfig,
  logger?: Logger,
): Promise<z.output<S>> {
  const log = logger ?? console;
  const maxRetries = configs.maxRetries ?? 2;
  const includeSchemaInPrompt = configs.includeSchemaInPrompt ?? true;
  const schemaName = configs.schemaName ?? "results";
  const startedAt = Date.now();

  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    const error = new Error("maxRetries must be a non-negative integer");
    log.error({ err: error }, "Invalid parser configuration");
    throw error;
  }

  let schemaFormat: SchemaFormat | undefined;
  let schemaRendered = false;
  const renderSchema = async (): Promise<SchemaFormat | undefined> => {
    if (schemaRendered) return schemaFormat;

    schemaRendered = true;
    try {
      const { zodResponseFormat } = await openAiZod();
      schemaFormat = zodResponseFormat(schema, schemaName);
    } catch (error: unknown) {
      log.warn(
        { err: error },
        "Schema cannot be rendered as a strict response format; the correction prompt carries it instead",
      );
      schemaFormat = undefined;
    }
    return schemaFormat;
  };

  const baseMessages: ChatCompletionMessageParam[] = [...configs.messages];
  let response = llmResponse;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptNumber = attempt + 1;
    const choice = response.choices.at(0);

    log.debug(
      {
        attempt: attemptNumber,
        maxAttempts: maxRetries + 1,
        responseId: response.id,
        model: response.model,
        finishReason: choice?.finish_reason,
        usage: response.usage,
      },
      "Validating LLM response",
    );

    let responseError: Error | undefined;

    if (!choice) {
      responseError = new Error("Model returned no choices");
    } else if (choice.message.refusal) {
      responseError = new Error("Model refused the request");
    } else if (choice.finish_reason !== "stop") {
      responseError = new Error(
        `Model did not finish normally: ${choice.finish_reason}`,
      );
    }

    if (responseError) {
      log.error(
        { err: responseError, attempt: attemptNumber },
        "LLM response cannot be parsed",
      );
      throw responseError;
    }

    const content = choice?.message.content;
    let failure: Error;
    let feedback: string;
    let cleanedReply: string | undefined;

    try {
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Model returned no textual answer");
      }

      const cleaned = removeCodeFence(removeThinking(content));
      if (!cleaned.trim()) {
        throw new Error("Model returned no final answer");
      }

      cleanedReply = cleaned;

      const parsed: unknown = JSON.parse(cleaned);
      const validation = schema.safeParse(parsed);

      if (validation.success) {
        log.debug(
          {
            attempt: attemptNumber,
            retriesUsed: attempt,
            elapsedMs: Date.now() - startedAt,
          },
          "LLM response validated successfully",
        );

        return validation.data;
      }

      failure = validation.error;
      feedback = JSON.stringify(
        validation.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          code: issue.code,
          message: issue.message,
        })),
      );
    } catch (error: unknown) {
      failure = error instanceof Error ? error : new Error(String(error));

      feedback =
        failure instanceof SyntaxError
          ? "Response is not valid JSON."
          : failure.message;
    }

    log.debug(
      { attempt: attemptNumber, validationErrors: feedback },
      "LLM response validation failed",
    );

    if (attempt === maxRetries) {
      log.error(
        {
          attempt: attemptNumber,
          validationErrors: feedback,
          elapsedMs: Date.now() - startedAt,
        },
        "LLM schema repair attempts exhausted",
      );
      throw failure;
    }

    const correction: ChatCompletionMessageParam[] = [...baseMessages];

    if (cleanedReply !== undefined) {
      correction.push({ role: "assistant", content: cleanedReply });
    }

    const schemaFormatForRetry = await renderSchema();
    const correctionParts = [
      "Your previous response failed JSON/schema validation.",
      `Validation errors: ${feedback}`,
      "Return the complete corrected JSON matching the supplied schema.",
      "Preserve evidence-grounded content; do not invent missing facts.",
      "Correct required fields, types, and nesting. Remove forbidden keys.",
      "Return only JSON, without markdown or commentary.",
    ];

    if (includeSchemaInPrompt && schemaFormatForRetry !== undefined) {
      correctionParts.push(
        `Schema: ${JSON.stringify(schemaFormatForRetry.json_schema.schema)}`,
      );
    }

    correction.push({ role: "user", content: correctionParts.join("\n") });

    log.debug({ retry: attempt + 1 }, "Requesting corrected LLM response");

    try {
      response = await configs.retry({
        messages: correction,
        ...(schemaFormatForRetry === undefined
          ? {}
          : { response_format: schemaFormatForRetry }),
      });
    } catch (error: unknown) {
      log.error(
        { err: error, retry: attempt + 1 },
        "LLM repair request failed",
      );
      throw error;
    }
  }

  throw new Error("Unexpected parser termination");
}
