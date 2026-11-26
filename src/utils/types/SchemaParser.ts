import type { zodResponseFormat } from "openai/helpers/zod.js";
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
} from "openai/resources";

/** A rendered strict response format, from `zodResponseFormat`. */
export type SchemaFormat = ReturnType<typeof zodResponseFormat>;

/** The request a schema repair attempt sends. */
export interface RetryRequest {
  /** The original messages plus the correction prompt. */
  messages: ChatCompletionMessageParam[];
  /**
   * The strict schema, when it could be rendered.
   *
   * Omitted for schemas strict structured outputs cannot express; the schema is
   * then carried in the correction prompt instead.
   */
  response_format?: SchemaFormat;
}

/** Settings for {@link llmSchemaParser}. */
export interface ParserConfig {
  /** Name of the agent, for logging. */
  agent: string;
  /** Messages prepended to every repair attempt. */
  messages: readonly ChatCompletionMessageParam[];
  /**
   * Name used for the rendered JSON schema.
   *
   * @default "results"
   */
  schemaName?: string;
  /**
   * Model calls allowed after the initial response.
   *
   * @default 2
   */
  maxRetries?: number;
  /**
   * Include the rendered JSON Schema in each correction prompt.
   *
   * Set `false` for very large schemas that are already in the system prompt.
   *
   * @default true
   */
  includeSchemaInPrompt?: boolean;
  /** Runs one repair request with the caller's client, model, and settings. */
  retry: (request: RetryRequest) => Promise<ChatCompletion>;
}
