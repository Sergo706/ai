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
 * Everything that shapes the payload — body, method, path, query, stream,
 * signal — is owned by the turn and rejected here, so there is exactly one
 * place each of those can be set.
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
  /** Answer temperature. Defaults to `0.4`. */
  temperature?: number;
  /** Answer token cap, sent as `max_tokens`. Defaults to `8192`. */
  maxTokens?: number;
  /**
   * Settings for tool-decision rounds. Each falls back to the answer setting.
   *
   * Lower temperature and a smaller cap here is the usual choice: a round only
   * has to emit a well-formed call, not prose.
   */
  tools?: {
    temperature?: number;
    maxTokens?: number;
    /** Rounds that may call tools. Zero disables tools entirely. */
    maxRounds?: number;
    /** Attempted calls across all rounds, not per round. */
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
   * A bare name uses the package defaults — its definition, factory, cache and
   * disclosure policy. An object with the same `name` tunes those, so a host can
   * set a call cap or hand its own factory to a built-in without rebuilding the
   * definition.
   */
  common?: CommonTools<TMeta>;
  /** MCP servers. Their tools are advertised to the model under their namespace. */
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
  /** Persist the user and assistant messages. Defaults to `true`. */
  persist?: boolean;
}

/**
 * Wraps the turn in the run system: a `runs` row before any work, a lease so two
 * replicas cannot both answer, a heartbeat, a terminal status, and the event log.
 *
 * Requires `conversation` with `persist` on: a run row carries `conversation_id`,
 * and a run whose messages are not persisted has nothing to resume into. The
 * type system cannot express "this field requires that one", so `createAgent`
 * validates it and throws at construction — failing at boot beats failing on the
 * first request.
 */
export interface RunOptions {
  /** `runs.kind` for this agent's turns. Defaults to `"chat"`. */
  kind?: RunKind;
  /**
   * Discriminator within `kind`, recorded on `runs.input.name`.
   *
   * Only needed when a host reuses one `kind` for several agents and its
   * recovery has to tell them apart.
   */
  name?: string;
  /**
   * Mirror progress into the in-process registry so a client that dropped can
   * reattach with `streamFromRun`.
   *
   * The durable event log is written either way; this only adds the fast
   * same-process replay path.
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
  /** Maximum files per turn. Defaults to 3. */
  maxFiles?: number;
  /** Maximum bytes per file. Defaults to 10 MB. */
  maxBytes?: number;
  /** Accepted mime types. Defaults to the formats `parseFiles` can read. */
  mimeTypes?: readonly string[];
  /** Pages read from a PDF before truncating. Defaults to 5. */
  maxPdfPages?: number;
}

/** Per-agent embedding overrides. */
export interface EmbeddingOptions {
  /** Model used for document retrieval. */
  retrievalModel?: string;
  /** Model used for the semantic cache. Kept separate from retrieval on purpose. */
  matchingModel?: string;
  /** Vector size, when it differs from the global configuration. */
  dimensions?: number;
}

/** Folds old messages into a rolling summary. Requires `conversation`. */
export type CompactionOptions = Compaction & {
  /** Write attempts for the watermark; a failed write never fails the turn. */
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
  /** Cosine similarity at which an earlier answer counts as the same question. Defaults to `0.9`. */
  similarity?: number;
  /** How far back to look, in hours. Defaults to `24`. */
  windowHours?: number;
  /**
   * Tools whose earlier use disqualifies a cached answer.
   *
   * A cached reply came from a turn that did not call these tools, and an answer
   * that needed live data is not safe to reuse.
   */
  poisonTools?: readonly string[];
  /**
   * Skips the lookup for one turn, e.g. after a retry or when the caller knows
   * the answer must be fresh. Returning `true` runs the model instead.
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
  model: ModelOptions;
  /**
   * Who this agent is.
   *
   * Prepended to every turn ahead of the history, so it is written once and
   * applies to every conversation the agent serves.
   */
  systemInstructions: string;
  tools?: ToolOptions<TMeta>;
  conversation?: ConversationOptions;
  runs?: RunOptions;
  compaction?: CompactionOptions;
  semanticCache?: SemanticCacheOptions;
  /** Limits for caller-attached files. */
  attachments?: AttachmentOptions;
  /** Overrides for the global embedding configuration. */
  embedding?: EmbeddingOptions;
  /** Extra fields handed to every tool factory. */
  meta?: TMeta;
  /**
   * Extra trace fields to collect per turn.
   *
   * The core trace is fixed (`reasoning`, `steps`); an extension adds what only
   * the host cares about, and its fields are merged into `ChatTurnResult.trace`.
   */
  trace?: readonly TraceExtension<Record<string, unknown>>[];
}

/**
 * Ask for a JSON answer.
 *
 * By default the request is sent with `response_format: { type: "json_object" }`
 * and nothing else happens: the raw JSON text comes back in
 * `ChatTurnResult.text`, the turn still streams, and no extra model call is
 * made. Parsing is opt-in through `validate`.
 *
 * With `validate: true` the reply is checked against `schema` and repaired with
 * follow-up calls when it does not match, and the accepted value is returned in
 * `ChatTurnResult.structured`. That path runs without streaming, because the
 * object only exists once the whole reply parses.
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
   * Defaults to `false`. When `true`, `schema` is required and the turn runs
   * without streaming.
   */
  validate?: boolean;
  /** Shape the answer must satisfy. Required when `validate` is `true`. */
  schema?: S;
  /** Name used for the rendered schema. Defaults to `"results"`. */
  schemaName?: string;
  /** Repair attempts after the first reply. Defaults to 2. */
  maxRetries?: number;
  /** Include the rendered schema in each repair prompt. Defaults to true. */
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
   * History to use when `conversation` is absent.
   *
   * Ignored when a conversation is configured, because the stored transcript is
   * then the truth and merging the two would duplicate messages.
   */
  history?: readonly HistoryMessage[];
  /** Files to inline. Checked against `AgentConfig.attachments`. */
  files?: readonly File[];
  /**
   * Owner of the conversation. Required whenever `conversation` is configured,
   * because every message row is scoped by it.
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
    locale?: string;
    timezone?: string;
    currentDate?: string;
    geo?: string;
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
   * The collected reasoning and tool trace for this turn.
   *
   * Includes whatever the configured `trace` extensions contributed, so the
   * value a host reports on is the one it asked to collect.
   */
  trace: (MessageTrace & Record<string, unknown>) | null;
  /** True when the answer came from the semantic cache instead of the model. */
  cached: boolean;
  /** The validated object, present only when the turn asked for one with `json`. */
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
