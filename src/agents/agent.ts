import type { z } from "zod";
import { generateEmbedding } from "../rag/embedding";
import { parseFiles } from "../chat/attachments";
import { resolveConversation } from "../chat/conversation";
import { TraceCollector } from "../chat/traceCollector";
import { EMPTY_COMPACTION_STATE } from "../chat/compactChat";
import type { CompactionState, HistoryMessage } from "../types/Compaction";
import { claimRun, startLeaseHeartbeat } from "../models/runLease";
import { createRun } from "../models/runs";
import { saveUserMessage } from "../models/saveMessages";
import { registerRun, publish } from "../runs/runRegistry";
import type { RunHandle } from "../runs/types";
import type { AgentEvent, ToolLoopOptions } from "../types/ToolExecutionTypes";
import { cachedTurn } from "./cachedTurn";
import { buildFinisher } from "./finish";
import { runJsonTurn } from "./jsonTurn";
import { buildHistoryMessages } from "./prompt";
import { composeMessages } from "./composeMessages";
import { runStreamTurn } from "./streamTurn";
import { assembleTools, bindTools } from "./tools";
import {
  combineSignals,
  logger,
  resolveClient,
  turnModel,
  userContext,
} from "./utils";
import type {
  Agent,
  AgentConfig,
  ChatStream,
  ChatTurnResult,
  JsonChatInput,
  JsonOptions,
} from "./types";

const DEFAULT_CHAT_TEMPERATURE = 0.4;
const DEFAULT_CHAT_MAX_TOKENS = 8_192;
const DEFAULT_TOOL_TEMPERATURE = 0.1;
const DEFAULT_TOOL_MAX_TOKENS = 4_096;
type Output<S extends z.ZodType> = z.output<S>;

/** @internal */
export async function buildAgent<TMeta = unknown>(
  config: AgentConfig<TMeta>,
): Promise<Agent<TMeta>> {
  const log = logger();
  const persistsConversation =
    config.conversation !== undefined && config.conversation.persist !== false;

  if (config.runs && !persistsConversation) {
    throw new Error(
      "AgentConfig: `runs` requires `conversation` with `persist: true`.",
    );
  }
  if (config.compaction && !persistsConversation) {
    throw new Error(
      "AgentConfig: `compaction` requires `conversation` with `persist: true`.",
    );
  }

  const tools = await assembleTools(config.tools);
  const client = resolveClient(config.model.request);
  let closed = false;

  async function chat<S extends z.ZodType = z.ZodNever>(
    input: JsonChatInput<TMeta, S>,
  ): Promise<ChatStream<Output<S>>> {
    if (closed) throw new Error("Agent is closed and cannot start new turns.");
    if (persistsConversation && input.userId === undefined) {
      throw new Error(
        "ChatInput: `userId` is required when `conversation` is enabled.",
      );
    }

    const model = turnModel(config.model, input.model);
    const meta = { ...config.meta, ...input.meta } as TMeta;

    const attachments = await parseFiles(
      input.files === undefined ? undefined : [...input.files],
      input.message,
      config.attachments,
    );

    const resolved =
      persistsConversation && input.userId !== undefined
        ? await resolveConversation(
            input.userId,
            input.conversationId,
            input.message,
          )
        : undefined;

    if (resolved !== undefined && !resolved.ok)
      throw new Error(resolved.reason);

    const conversationId = resolved?.ok === true ? resolved.id : undefined;
    const history: readonly HistoryMessage[] =
      resolved?.ok === true ? resolved.history : (input.history ?? []);

    const state: CompactionState =
      resolved?.ok === true ? resolved.compaction : EMPTY_COMPACTION_STATE;

    const run: RunHandle | undefined = config.runs
      ? registerRun({
          id: input.runId ?? crypto.randomUUID(),
          kind: config.runs.kind ?? "chat",
          conversationId,
          status: "running",
          startedAt: Date.now(),
        })
      : undefined;

    const cacheHit = await cachedTurn<Output<S>>({
      options: config.semanticCache,
      conversationId,
      userId: input.userId,
      hasFiles: attachments.hasFiles,
      message: attachments.message,
      log,
      run,
      runName: config.runs?.name,
    });
    if (cacheHit !== null) return cacheHit;

    if (conversationId !== undefined) {
      const embedding = await generateEmbedding(input.message);
      await saveUserMessage(conversationId, attachments.message, embedding);
    }

    const registry = bindTools(tools.specs, {
      userId: input.userId ?? "anonymous",
      conversationId,
      meta,
    });

    const trace = new TraceCollector<Record<string, unknown>>(
      config.trace ?? [],
    );

    const historyMessages = await buildHistoryMessages({
      history: [...history],
      state,
      compaction: config.compaction,
      conversationId,
      client,
      model,
    });

    const messages = composeMessages({
      systemInstructions: config.systemInstructions,
      userContext: userContext(input.user),
      history: historyMessages,
      message: attachments.message,
    });

    const json = input.json as JsonOptions | undefined;
    const schema = json?.validate === true ? json.schema : undefined;
    const signal = combineSignals(input.signal, run?.controller.signal);

    // A plain JSON ask is just `response_format` on a normal streamed turn; only
    // a validated one leaves the streaming path.
    if (json !== undefined && schema === undefined) {
      model.body = { ...model.body, response_format: { type: "json_object" } };
    }

    const loopOptions: ToolLoopOptions = {
      client,
      model: model.model,
      messages,
      availableTools: tools.definitions,
      tools: {
        temperature: model.tools?.temperature ?? DEFAULT_TOOL_TEMPERATURE,
        maxTokens: model.tools?.maxTokens ?? DEFAULT_TOOL_MAX_TOKENS,
        ...(model.tools?.maxRounds === undefined
          ? {}
          : { maxRounds: model.tools.maxRounds }),
        ...(model.tools?.maxCalls === undefined
          ? {}
          : { maxCalls: model.tools.maxCalls }),
      },
      chat: {
        temperature: model.temperature ?? DEFAULT_CHAT_TEMPERATURE,
        maxTokens: model.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
      },
      handlers: registry.handlers,
      toolConcurrency: registry.toolConcurrency,
      toolStreaming: registry.toolStreaming,
      ...(signal === undefined ? {} : { signal }),
      ...(model.thinkingEffort === undefined
        ? {}
        : { thinkingEffort: model.thinkingEffort }),
      ...(model.body === undefined ? {} : { body: model.body }),
      ...(run === undefined
        ? {}
        : {
            emit: (event: AgentEvent) => {
              publish(run, event);
            },
          }),
      onToolResult: trace.addStep,
    };

    const finish = buildFinisher<Output<S>>({
      run,
      conversationId,
      registry,
      trace,
    });

    let stopHeartbeat: (() => void) | undefined;
    if (run !== undefined && conversationId !== undefined) {
      await createRun({
        id: run.id,
        kind: run.kind,
        query: attachments.message,
        userId: input.userId ?? null,
        conversationId,
        ...(config.runs?.name === undefined
          ? {}
          : { input: { name: config.runs.name } }),
      });
      await claimRun(run.id);
      stopHeartbeat = startLeaseHeartbeat(
        run.id,
        () => {
          run.controller.abort();
        },
        log,
      );
    }

    if (json !== undefined && schema !== undefined) {
      return runJsonTurn<Output<S>>({
        loopOptions,
        client,
        chat: loopOptions.chat,
        model: model.model,
        messages,
        json: { ...json, schema },
        trace,
        finish,
        conversationId,
        stopHeartbeat,
      });
    }

    return runStreamTurn<Output<S>>({
      loopOptions,
      trace,
      finish,
      conversationId,
      stopHeartbeat,
      eager: run !== undefined,
    });
  }

  async function complete<S extends z.ZodType = z.ZodNever>(
    input: JsonChatInput<TMeta, S>,
  ): Promise<ChatTurnResult<Output<S>>> {
    const stream = await chat(input);
    for await (const frame of stream.frames) {
      // Draining is what makes a non-run turn execute.
      if (frame.type === "done") break;
    }
    return stream.done;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await tools.mcp?.close();
  }

  return {
    chat,
    complete,
    close,
    config: Object.freeze({ ...config }),
  };
}
