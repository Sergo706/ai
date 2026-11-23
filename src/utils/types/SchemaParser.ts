import { zodResponseFormat } from "openai/helpers/zod.js";
import { ChatCompletion, ChatCompletionMessageParam } from "openai/resources";


export type SchemaFormat = ReturnType<typeof zodResponseFormat>;

export interface RetryRequest {
  messages: ChatCompletionMessageParam[];
  /**
   * The strict schema, when it could be rendered.
   *
   * Optional because `zodResponseFormat` throws for constructs strict structured
   * outputs reject — `.optional()` without `.nullable()`, `z.record()`, anything
   * that cannot express `additionalProperties: false`. Callers send
   * `json_object` and read the schema from the prompt, so a schema it cannot
   * render is not a reason to fail the repair.
   */
  response_format?: SchemaFormat;
}

export interface ParserConfig {
  agent: string;
  messages: readonly ChatCompletionMessageParam[];
  schemaName?: string;
  /** additional model calls after the initial response. Default: 2. */
  maxRetries?: number;
  /**
   * Include the rendered JSON Schema text in each correction prompt.
   *
   * Default: true. The prompt is the only place the model reliably sees the
   * schema, because the providers here reject `json_schema` response formats.
   * Set false for very large schemas when the schema is already in the system
   * prompt.
   */
  includeSchemaInPrompt?: boolean;
  /** uses the caller's client, model, and generation settings. */
  retry: (request: RetryRequest) => Promise<ChatCompletion>;
}