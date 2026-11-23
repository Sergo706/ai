import type OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsBase,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { StoredToolStep } from "../db/schema.js";
import type { WorkflowAgent, WorkflowName } from "./Chat.js";
import type { WorkflowStage } from "../agentic-loop/types.js";


export interface Chat {
  temperature: number;
  maxTokens: number;
}
export interface Tools {
  temperature: number;
  maxTokens: number;
  /** Maximum tool-enabled rounds; defaults to 5. Zero disables tools. */
  maxRounds?: number;
  /** Maximum attempted calls across all rounds; defaults to 20. */
  maxCalls?: number;
}

/** Per-request transport options forwarded to the provider client. */
export interface ToolLoopRequestOptions {
  /** Aborts the in-flight provider call when the caller goes away. */
  signal?: AbortSignal;
}

export type ToolLoopClient = Pick<OpenAI, "chat">;

/** Thinking budget forwarded to the provider as `reasoning_effort`. */
export type ThinkingEffort = "low" | "medium" | "high" | "max";

/**
 * Body fields the loop forwards untouched.
 *
 */
export type ModelBodyOptions = Pick<
  ChatCompletionCreateParamsBase,
  | "top_p"
  | "presence_penalty"
  | "frequency_penalty"
  | "stop"
  | "seed"
  | "response_format"
  | "parallel_tool_calls"
  | "verbosity"
  | "service_tier"
>;

export interface ToolExecutionContext {
  toolCallId: string;
  /**
   * The run's cancellation token.
   *
   * Long-running tools (research takes 10-17 minutes) must be able to observe a
   * stop request. Without this the tool loop can be cancelled while the tool
   * itself keeps working, which is exactly what a stop button must not do.
   */
  signal?: AbortSignal;
  /** 1-based ordinal of this tool's calls within the current request. */
  callIndex: number;
  /**
   * Calls the model has planned for this tool so far: every call executed in earlier
   * rounds plus the calls it requested in the current one. The model decides live how
   * many it needs, so this grows rather than being a configured cap.
   */
  callTotal: number;
  emit?: AgentEventEmitter;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => unknown;

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => unknown;

export type ToolExecutionDependencies =
  | {
      executor: ToolExecutor;
      handlers?: never;
    }
  | {
      executor?: never;
      handlers?: Readonly<Record<string, ToolHandler>>;
    };

/**
 * How much of a tool's payload is allowed onto the SSE stream.
 * Applied at emit time inside the tool loop, so handlers stay unaware of it.
 */
export interface ToolStreamPolicy {
  /** Emit the model's arguments in `tool_start`. Defaults to true. */
  emitArgs?: boolean;
  /**
   * `full` sends the whole result, `preview` truncates it, `none` sends no payload
   * at all while still emitting `tool_start` / `tool_end` so the UI keeps its bookends.
   * Defaults to `preview`.
   */
  emitResult?: "full" | "preview" | "none";
  /** Declared cap for this tool, surfaced as `callTotal` ("research 2/5"). */
  maxCalls?: number;
  /**
   * Rewrites a structured result into the text the model receives.
   *
   * A handler that returns an object would otherwise reach the model as raw
   * `JSON.stringify` output. This lets it return a typed value to the app code
   * while the model gets something compact and readable, for example
   * `jsonToMarkdown(result)`.
   *
   * Only applies to non-string results: a handler that already returned a
   * string has decided its own wire format, and a string is what an error
   * envelope is, so rewriting it would corrupt errors.
   */
  serializeForModel?: (result: unknown) => string;
}
/** One frame of the assistant's live execution, forwarded to the SSE endpoint. */
export type AgentEvent =
  | { type: "chunk"; text: string }
  | { type: "reasoning"; round: number; delta: string }
  | {
      type: "tool_start";
      id: string;
      name: string;
      /** Model arguments, or null when this tool suppresses them. */
      args?: unknown;
      callIndex: number;
      callTotal: number;
    }
  | {
      type: "tool_end";
      id: string;
      name: string;
      ok: boolean;
      durationMs: number;
      preview: string;
      callIndex: number;
      callTotal: number;
    }
  | {
      type: "workflow_start";
      runId: string;
      /** The route's own identity, not a retrieval flavour. */
      workflow: WorkflowName;
      query: string;
      callIndex: number;
      callTotal: number;
    }
  | {
      type: "workflow_progress";
      runId?: string;
      workflow: WorkflowName;
      stage: WorkflowStage;
      /** Human-readable caption for the unit being worked on. */
      label?: string;
      addedEvidence: boolean;
      round?: number;
      intent?: string;
      message?: string;
      /** Workflow-specific payload; the loop forwards it untouched. */
      custom?: Record<string, unknown>;
      callIndex: number;
      callTotal: number;
    }
  | {
      type: "agent_progress";
      agent: WorkflowAgent;
      state: "running" | "done" | "failed";
    }
  | { type: "error"; message: string };

export type AgentEventEmitter = (event: AgentEvent) => void;

export type ToolLoopOptions = ToolExecutionDependencies & {
  client: ToolLoopClient;
  model: string;
  messages: readonly ChatCompletionMessageParam[];
  availableTools: readonly ChatCompletionTool[];
  tools: Tools;
  chat: Chat;
  stream?: boolean;
  signal?: AbortSignal;
  toolConcurrency?: Readonly<Record<string, number>>;
  /** Per-tool payload disclosure; missing entries use the defaults. */
  toolStreaming?: Readonly<Record<string, ToolStreamPolicy>>;
  /** Receives every live event; omit to run silently. */
  emit?: AgentEventEmitter;
  /**
   * Receives each executed tool's unredacted result for persistence. Kept separate
   * from `emit` because `emit` deliberately redacts to the SSE policy, while the
   * trace needs the real payload so the agent can reuse it on later turns.
   */
  onToolResult?: (step: StoredToolStep) => void;
  /** Provider thinking budget. */
  thinkingEffort?: ThinkingEffort;
  /** Sampling and output-shape params spread into every request body. */
  body?: ModelBodyOptions;
};

export type ToolCall = NonNullable<
  ChatCompletion["choices"][number]["message"]["tool_calls"]
>[number];

/** Tool call assembled from streamed deltas, keyed by the provider's index. */
export interface AssembledCall {
  id: string;
  name: string;
  arguments: string;
}
export type RoundOutcome =
  | { kind: "answer"; content: string }
  | { kind: "tools"; content: string; calls: AssembledCall[] };

export interface ToolLoopResult {
  /** True when the loop already streamed the natural finish (stream mode). */
  answerStreamed?: boolean;
  /** Populated in non-stream mode when the loop finished naturally. */
  completedCompletion?: ChatCompletion;
  /** Populated only when maxRounds/maxCalls was hit (or no tools exist). */
  finalRequest?: ChatCompletionCreateParamsNonStreaming;
}