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

/** Sampling settings for the final answer call. */
export interface Chat {
  /** Temperature for the answer. */
  temperature: number;
  /** Token cap for the answer. */
  maxTokens: number;
}

/** Sampling settings for the rounds that may call tools. */
export interface Tools {
  /** Temperature for tool-decision rounds. */
  temperature: number;
  /** Token cap for tool-decision rounds. */
  maxTokens: number;
  /**
   * Maximum tool-enabled rounds. `0` disables tools entirely.
   *
   * @default 5
   */
  maxRounds?: number;
  /**
   * Maximum attempted calls across all rounds, not per round.
   *
   * @default 20
   */
  maxCalls?: number;
}

/** Per-request transport options forwarded to the provider client. */
export interface ToolLoopRequestOptions {
  /** Aborts the in-flight provider call when the caller goes away. */
  signal?: AbortSignal;
}

/** The provider surface the tool loop needs, so any OpenAI-compatible client works. */
export type ToolLoopClient = Pick<OpenAI, "chat">;

/** Thinking budget forwarded to the provider as `reasoning_effort`. */
export type ThinkingEffort = "low" | "medium" | "high" | "max";

/**
 * Body fields the loop forwards untouched.
 *
 * Everything else about the request body is owned by the loop.
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

/** What a tool handler is given for one invocation. */
export interface ToolExecutionContext {
  /** Provider id of this call. */
  toolCallId: string;
  /**
   * The run's cancellation token.
   *
   * Long-running tools must observe it, so a stop request actually stops the
   * work instead of only stopping the loop.
   */
  signal?: AbortSignal;
  /** 1-based ordinal of this tool's calls within the current request. */
  callIndex: number;
  /** How many calls the model has planned for this tool so far. */
  callTotal: number;
  /** Emit a live event, e.g. to report sub-progress. */
  emit?: AgentEventEmitter;
}

/** Handles one tool call. */
export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => unknown;

/** Dispatches one tool call by name. */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => unknown;

/**
 * How the loop reaches your tools: either one dispatcher, or a handler map.
 *
 * Supply exactly one of the two.
 */
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
 * How much of a tool's payload reaches the SSE stream.
 *
 * Applied when the loop emits, so handlers stay unaware of it.
 */
export interface ToolStreamPolicy {
  /**
   * Emit the model's arguments in `tool_start`.
   *
   * @default true
   */
  emitArgs?: boolean;
  /**
   * How much of the result to send.
   *
   * `full` sends all of it, `preview` truncates it, `none` sends no payload
   * while still emitting `tool_start`/`tool_end` so the UI keeps its bookends.
   *
   * @default "preview"
   */
  emitResult?: "full" | "preview" | "none";
  /** Declared call cap for this tool, surfaced as `callTotal` in progress events. */
  maxCalls?: number;
  /**
   * Rewrites a structured result into the text the model receives.
   *
   * Without it a handler that returns an object reaches the model as raw
   * `JSON.stringify` output. With it the app keeps a typed value while the model
   * gets something compact, e.g. `jsonToMarkdown(result)`.
   *
   * Only applies to non-string results: a string is already the handler's own
   * wire format, and rewriting it would corrupt error envelopes.
   */
  serializeForModel?: (result: unknown) => string;
}
/**
 * One frame of the assistant's live execution.
 *
 * `chunk` and `reasoning` carry text, `tool_start`/`tool_end` bracket a call,
 * the `workflow_*` and `agent_progress` frames report long-task progress.
 */
export type AgentEvent =
  | { type: "chunk"; text: string }
  | { type: "reasoning"; round: number; delta: string }
  | {
      type: "tool_start";
      /** Provider id of this call. */
      id: string;
      /** Tool name as the model called it. */
      name: string;
      /** Model arguments, omitted when the tool's policy suppresses them. */
      args?: unknown;
      /** 1-based ordinal of this tool's calls in the request. */
      callIndex: number;
      /** How many calls the model planned for this tool. */
      callTotal: number;
    }
  | {
      type: "tool_end";
      /** Provider id of this call, matching `tool_start`. */
      id: string;
      /** Tool name. */
      name: string;
      /** Whether the handler succeeded. */
      ok: boolean;
      /** Wall-clock duration of the call. */
      durationMs: number;
      /** Result text, trimmed to the tool's disclosure policy. */
      preview: string;
      /** 1-based ordinal of this tool's calls in the request. */
      callIndex: number;
      /** How many calls the model planned for this tool. */
      callTotal: number;
    }
  | {
      type: "workflow_start";
      /** The run this workflow belongs to. */
      runId: string;
      /** The workflow's own name. */
      workflow: WorkflowName;
      /** The question the run works on. */
      query: string;
      /**
       * Unused by this frame; `runProgressFrames` does not emit it.
       *
       * Kept because it is required by the type, not because a consumer reads
       * it here.
       */
      callIndex: number;
      /** Unused by this frame; `runProgressFrames` does not emit it. */
      callTotal: number;
    }
  | {
      type: "workflow_progress";
      /** Attached once the run has started. */
      runId?: string;
      /** The workflow's own name. */
      workflow: WorkflowName;
      /** Which stage produced this update. */
      stage: WorkflowStage;
      /** Human-readable caption for the unit being worked on. */
      label?: string;
      /** Whether this unit added evidence the evaluator will see. */
      addedEvidence: boolean;
      /** Round number, when the stage has rounds. */
      round?: number;
      /** The intent this unit belongs to. */
      intent?: string;
      /** Diagnostic message for the log, never UI content. */
      message?: string;
      /** Workflow-specific payload; the loop forwards it untouched. */
      custom?: Record<string, unknown>;
      /** Unused by this frame; `runProgressFrames` does not emit it. */
      callIndex: number;
      /** Unused by this frame; `runProgressFrames` does not emit it. */
      callTotal: number;
    }
  | {
      type: "agent_progress";
      /** Which agent changed state. */
      agent: WorkflowAgent;
      /** Its new state. */
      state: "running" | "done" | "failed";
    }
  | { type: "error"; message: string };

/** Writes one `AgentEvent` to a stream. */
export type AgentEventEmitter = (event: AgentEvent) => void;

/** Everything the tool loop needs for one turn. */
export type ToolLoopOptions = ToolExecutionDependencies & {
  /** Provider client, or anything with the same `chat` surface. */
  client: ToolLoopClient;
  /** Model id. */
  model: string;
  /** Messages to send, system prompt included. */
  messages: readonly ChatCompletionMessageParam[];
  /** Tool definitions offered to the model. */
  availableTools: readonly ChatCompletionTool[];
  /** Sampling for tool-decision rounds. */
  tools: Tools;
  /** Sampling for the final answer. */
  chat: Chat;
  /** Stream the answer instead of returning a completion. */
  stream?: boolean;
  /** Cancels the turn. */
  signal?: AbortSignal;
  /** Concurrent calls allowed per tool name. */
  toolConcurrency?: Readonly<Record<string, number>>;
  /** Per-tool payload disclosure; missing entries use the defaults. */
  toolStreaming?: Readonly<Record<string, ToolStreamPolicy>>;
  /** Receives every live event; omit to run silently. */
  emit?: AgentEventEmitter;
  /**
   * Receives each executed tool's unredacted result, for persistence.
   *
   * Separate from `emit`, which redacts to the SSE policy: a trace needs the
   * real payload so the model can reuse it on later turns.
   */
  onToolResult?: (step: StoredToolStep) => void;
  /** Provider thinking budget. */
  thinkingEffort?: ThinkingEffort;
  /** Sampling and output-shape params spread into every request body. */
  body?: ModelBodyOptions;
};

/** One tool call as the provider returns it. */
export type ToolCall = NonNullable<
  ChatCompletion["choices"][number]["message"]["tool_calls"]
>[number];

/** Tool call assembled from streamed deltas, keyed by the provider's index. */
export interface AssembledCall {
  /** Provider id of the call. */
  id: string;
  /** Tool name. */
  name: string;
  /** Raw JSON arguments, as streamed. */
  arguments: string;
}

/** What one round of the loop decided to do. */
export type RoundOutcome =
  | { kind: "answer"; content: string }
  | { kind: "tools"; content: string; calls: AssembledCall[] };

/** What the tool loop produced. */
export interface ToolLoopResult {
  /** `true` when the loop already streamed the natural finish (stream mode). */
  answerStreamed?: boolean;
  /** Populated in non-stream mode when the loop finished naturally. */
  completedCompletion?: ChatCompletion;
  /** Populated only when `maxRounds`/`maxCalls` was hit, or no tools exist. */
  finalRequest?: ChatCompletionCreateParamsNonStreaming;
}
