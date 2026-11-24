import type OpenAI from "openai";
import type { z } from "zod";
import type { ToolSpec } from "../tools/toolRegistry";
import type { CommonTools } from "../tools/common-tools-handlers/specs";
import type { McpServerConfig } from "../types/mcp";
import type { TraceExtension } from "../chat/traceCollector";
import type { Compaction, HistoryMessage } from "../types/Compaction";
import type { SseFrame } from "../types/Chat";
import type { MessageTrace, RunKind } from "../db/schema";
import type { ModelBodyOptions, ThinkingEffort } from "../types/ToolExecutionTypes";

/**
 * SDK options that describe *how* a request travels, not what it contains.
 *
 * Body, method, path, query, stream and signal are owned by the turn, so they
 * are rejected here to keep a single place where each can be set.
 */
export type ModelRequestOptions = Omit<
  OpenAI.RequestOptions,
  | "method"
  | "path"
  | "query"
  | "body"
  | "stream"
  | "signal"
  | "__metadata"
  | "__security"
  | "__binaryResponse"
>;

/**
 * One provider call's settings.
 *
 * @example
 * ```ts
 * const model: ModelOptions = { model: "gpt-4o-mini", temperature: 0.3 };
 * ```
 */
export interface ModelOptions {
  /** Provider model id, e.g. `"gpt-4o-mini"`. */
  model: string;
  /**
   * Answer temperature.
   *
   * @default 0.4
   */
  temperature?: number;
  /**
   * Answer token cap, sent as `max_tokens`.
   *
   * @default 8192
   */
  maxTokens?: number;
  /** Settings for tool-decision rounds, kept separate from the answer call. */
  tools?: {
    /**
     * Temperature for tool-decision rounds.
     *
     * @default 0.1
     */
    temperature?: number;
    /**
     * Token cap for tool-decision rounds.
     *
     * @default 4096
     */
    maxTokens?: number;
    /**
     * Rounds that may call tools. `0` disables tools entirely.
     *
     * @default 5
     */
    maxRounds?: number;
    /**
     * Tool calls allowed across all rounds, not per round.
     *
     * @default 20
     */
    maxCalls?: number;
  };
  /** Provider reasoning budget, forwarded as `reasoning_effort`. */
  thinkingEffort?: ThinkingEffort;
  /** Transport-level SDK options, forwarded to every provider call. */
  request?: ModelRequestOptions;
  /**
   * Body params forwarded as-is to every request.
   *
   * `response_format` is overwritten per turn when `json` is used, because the
   * schema needs `json_object` regardless of what was configured.
   */
  body?: ModelBodyOptions;
}

/**
 * Everything the loop may call.
 *
 * @example
 * ```ts
 * const tools: ToolOptions = { common: ["calculator", "get_current_datetime"] };
 * ```
 */
export interface ToolOptions<TMeta = unknown> {
  /** The host's own tools. Each carries its own cache, caps and policy. */
  specs?: readonly ToolSpec<TMeta>[];
  /**
   * Built-in tools to expose.
   *
   * A bare name uses the package defaults: definition, factory, cache and
   * disclosure policy. An object with the same `name` tunes those.
   */
  common?: CommonTools<TMeta>;
  /** MCP servers. Their tools are advertised under the server's namespace. */
  mcp?: readonly McpServerConfig[];
}

/**
 * Where the turn is stored.
 *
 * @example
 * ```ts
 * const conversation: ConversationOptions = { persist: true };
 * ```
 */
export interface ConversationOptions {
  /**
   * Persist the user and assistant messages.
   *
   * @default true
   */
  persist?: boolean;
}

/**
 * Runs the turn through the run system: a `runs` row before any work, a lease so
 * two replicas cannot both answer, a heartbeat, a terminal status and the event
 * log.
 *
 * Requires `conversation.persist`: a run is stored against its conversation, so
 * a run whose messages are not persisted has nothing to resume into.
 * `createAgent` throws at construction when that pair is inconsistent.
 */
export interface RunOptions {
  /**
   * `runs.kind` for this agent's turns.
   *
   * @default "chat"
   */
  kind?: RunKind;
  /**
   * Name recorded on `runs.input.name`, to tell this agent's runs apart.
   *
   * Only needed when several agents share one `kind` and run recovery has to
   * distinguish them.
   */
  name?: string;
  /**
   * Also keep the live event stream in process memory, so a client that dropped
   * can reattach with `streamFromRun`.
   *
   * The durable event log is always written; this only enables same-process
   * replay.
   */
  registry?: boolean;
}

/**
 * Limits applied to files the caller attaches to a turn.
 *
 * @example
 * ```ts
 * const attachments: AttachmentOptions = { maxFiles: 2, maxBytes: 5_000_000 };
 * ```
 */
export interface AttachmentOptions {
  /**
   * Maximum files per turn.
   *
   * @default 3
   */
  maxFiles?: number;
  /**
   * Maximum size of one file, in bytes.
   *
   * @default 10485760 (10 MB)
   */
  maxBytes?: number;
  /**
   * Accepted mime types.
   *
   * @default the formats `parseFiles` can read
   */
  mimeTypes?: readonly string[];
  /**
   * Pages read from a PDF before the text is truncated.
   *
   * @default 5
   */
  maxPdfPages?: number;
}

/** Per-agent overrides for the global embedding configuration. */
export interface EmbeddingOptions {
  /** Model used to embed document chunks for retrieval. */
  retrievalModel?: string;
  /** Model used to embed messages for the semantic cache. */
  matchingModel?: string;
  /** Vector size, when it differs from the global configuration. */
  dimensions?: number;
}

/**
 * Folds old messages into a rolling summary once the history grows past a limit.
 *
 * Requires `conversation`.
 */
export type CompactionOptions = Compaction & {
  /**
   * Write attempts for the summary watermark; a failed write never fails the
   * turn.
   *
   * @default 2
   */
  attempts?: number;
};

/**
 * Answers a repeated question from a near-identical earlier exchange.
 *
 * @example
 * ```ts
 * const semanticCache: SemanticCacheOptions = { similarity: 0.92 };
 * ```
 */
export interface SemanticCacheOptions {
  /**
   * Cosine similarity at which an earlier answer counts as the same question.
   *
   * @default 0.9
   */
  similarity?: number;
  /**
   * How far back to look, in hours.
   *
   * @default 24
   */
  windowHours?: number;
  /**
   * Tools whose earlier use disqualifies a cached answer.
   *
   * An answer that needed live data is not safe to reuse.
   */
  poisonTools?: readonly string[];
  /**
   * Skip the lookup for one turn, e.g. after a retry.
   *
   * @returns `true` to call the model instead of reusing a cached answer.
   */
  skipEvaluator?: (conversationId: number, message: string) => boolean;
}

/**
 * One agent, reusable across turns.
 *
 * @example
 * ```ts
 * const config: AgentConfig = {
 *   model: { model: "gpt-4o-mini" },
 *   systemInstructions: "You are a concise assistant.",
 * };
 * ```
 */
export interface AgentConfig<TMeta = unknown> {
  /** Provider model, sampling and transport settings. */
  model: ModelOptions;
  /**
   * Who this agent is.
   *
   * Prepended to every turn ahead of the history, so it is written once and
   * applies to every conversation the agent serves.
   */
  systemInstructions: string;
  /** Tools the model may call. */
  tools?: ToolOptions<TMeta>;
  /** Where turns are stored. Omit to keep the agent stateless. */
  conversation?: ConversationOptions;
  /** Run tracking, leasing and event log. Requires `conversation.persist`. */
  runs?: RunOptions;
  /** Rolling summary of old messages. Requires `conversation`. */
  compaction?: CompactionOptions;
  /** Reuse a near-identical earlier answer instead of calling the model. */
  semanticCache?: SemanticCacheOptions;
  /** Limits for caller-attached files. */
  attachments?: AttachmentOptions;
  /** Overrides for the global embedding configuration. */
  embedding?: EmbeddingOptions;
  /** Extra fields handed to every tool factory. */
  meta?: TMeta;
  /**
   * Extra trace fields collected on every turn.
   *
   * The core trace is fixed (`reasoning`, `steps`); an extension adds what only
   * the host cares about, merged into `ChatTurnResult.trace`.
   */
  trace?: readonly TraceExtension<Record<string, unknown>>[];
}

/**
 * Ask for a JSON answer.
 *
 * With no `validate`, the request is sent with
 * `response_format: { type: "json_object" }` and the raw JSON text arrives in
 * `ChatTurnResult.text`; the turn still streams and no extra model call is made.
 *
 * With `validate: true`, the reply is checked against `schema` and repaired with
 * follow-up calls when it does not match, and the accepted value is returned in
 * `ChatTurnResult.structured`. That path cannot stream.
 *
 * @example
 * ```ts
 * // Just ask for JSON, no validation
 * await agent.complete({ message: "Give me JSON", json: {} });
 *
 * // Validate and get a typed object
 * const { structured } = await agent.complete({
 *   message: "Extract the date",
 *   json: { validate: true, schema: z.object({ date: z.string() }) },
 * });
 * ```
 */
export interface JsonOptions<S extends z.ZodType = z.ZodType> {
  /**
   * Validate the reply against `schema` and repair it when it fails.
   *
   * @default false
   */
  validate?: boolean;
  /** Shape the answer must satisfy. Required when `validate` is `true`. */
  schema?: S;
  /**
   * Name used when the schema is rendered into the prompt.
   *
   * @default "results"
   */
  schemaName?: string;
  /**
   * Repair attempts after the first reply.
   *
   * @default 2
   */
  maxRetries?: number;
  /**
   * Include the rendered schema in each repair prompt.
   *
   * @default true
   */
  includeSchemaInPrompt?: boolean;
}

/** A JSON turn whose reply has been validated, so `schema` is present. */
export type ValidatedJsonOptions = JsonOptions & { schema: z.ZodType };

/**
 * One turn.
 *
 * @example
 * ```ts
 * await agent.chat({ message: "Hello", userId: "u_1" });
 * ```
 */
export interface ChatInput<TMeta = unknown> {
  /** What the user said. */
  message: string;
  /**
   * History to use when no conversation is configured.
   *
   * Ignored when a conversation is configured, because the stored transcript is
   * then the truth.
   */
  history?: readonly HistoryMessage[];
  /** Files to inline. Checked against `AgentConfig.attachments`. */
  files?: readonly File[];
  /**
   * Owner of the conversation.
   *
   * Required whenever `conversation` is configured, because every message row
   * is scoped by it.
   */
  userId?: string;
  /** Continue an existing conversation. Omit to start a new one. */
  conversationId?: number;
  /** Use this id for the run instead of generating one. */
  runId?: string;
  /** Cancels the turn. Combined with the run's own stop signal. */
  signal?: AbortSignal;
  /** Sampling overrides for this turn only. `request` stays agent-wide. */
  model?: Partial<Omit<ModelOptions, "request">>;
  /** Request-scoped fields for this turn's tool factories. */
  meta?: Partial<TMeta>;
  /** Context about the person asking, appended to the system prompt. */
  user?: {
    /** Locale hint, e.g. `"en-GB"`. */
    locale?: string;
    /** Timezone hint, e.g. `"Europe/London"`. */
    timezone?: string;
    /** Today's date, when the host wants to be explicit about it. */
    currentDate?: string;
    /** Location hint used for locally-relevant answers. */
    geo?: string;
    /** Any other facts worth passing to the model. */
    other?: readonly string[];
  };
}

/** A turn that asks for a JSON answer, with the shape it must satisfy. */
export type JsonChatInput<TMeta, S extends z.ZodType> = ChatInput<TMeta> & {
  json?: JsonOptions<S>;
};

/**
 * A turn in progress.
 *
 * `frames` is the live event stream; `done` resolves with the result whether or
 * not anyone read the frames.
 */
export interface ChatStream<TStructured = never> {
  /** Live events, already framed for SSE. */
  frames: AsyncIterable<SseFrame>;
  /** Resolves when the turn ends, whatever the outcome. */
  done: Promise<ChatTurnResult<TStructured>>;
}

/** The outcome of one turn. */
export interface ChatTurnResult<TStructured = never> {
  /** Present when the run system is enabled. */
  runId?: string;
  /** Present when the conversation is persisted. */
  conversationId?: number;
  /** The assistant's final text. Empty when the turn failed before answering. */
  text: string;
  /** Tools the model called, in order. */
  toolsUsed: readonly string[];
  /**
   * The reasoning and tool trace for this turn, or `null` when nothing was
   * recorded.
   *
   * Includes whatever the configured `trace` extensions contributed.
   */
  trace: (MessageTrace & Record<string, unknown>) | null;
  /** `true` when the answer came from the semantic cache instead of the model. */
  cached: boolean;
  /**
   * The validated object.
   *
   * Present only when the turn asked for a schema with
   * `json: { validate: true, schema }`.
   */
  structured?: TStructured;
  /** Set when the turn failed. */
  error?: Error;
}

/**
 * One reusable agent.
 *
 * @example
 * ```ts
 * const agent = await createAgent({ model: { model: "gpt-4o-mini" }, ... });
 * const { text } = await agent.complete({ message: "Hi" });
 * await agent.close();
 * ```
 */
export interface Agent<TMeta = unknown> {
  /**
   * Starts one turn and returns its live frames.
   *
   * Without `runs`, the loop starts when the first frame is pulled, so a caller
   * that only wants the result should use `complete` instead.
   *
   * @param input - The message, plus optional history, files and overrides.
   * @returns The live stream and the promise of its result.
   */
  chat<S extends z.ZodType = z.ZodNever>(
    input: JsonChatInput<TMeta, S>,
  ): Promise<ChatStream<z.output<S>>>;
  /**
   * Runs one turn to completion and returns its result.
   *
   * Drains the stream for you, which is what makes a non-run turn execute.
   *
   * @param input - The message, plus optional history, files and overrides.
   * @returns The answer text, the tools used and the filtered trace.
   */
  complete<S extends z.ZodType = z.ZodNever>(
    input: JsonChatInput<TMeta, S>,
  ): Promise<ChatTurnResult<z.output<S>>>;
  /** Closes MCP connections. The agent is unusable afterwards. */
  close(): Promise<void>;
  /** The resolved config, for a host that assembles its own loop with it. */
  readonly config: AgentConfig<TMeta>;
}
