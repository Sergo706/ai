import type { ChatCompletion, ChatCompletionMessageParam } from "openai/resources";
import type { z } from "zod";
import { executeToolLoop } from "../tools/execution";
import type { Chat, ToolLoopClient, ToolLoopOptions } from "../types/ToolExecutionTypes";
import type { TraceCollector } from "../chat/traceCollector";
import type { TerminalStatus } from "../runs/types";
import { llmSchemaParser } from "../utils/llmSchemaParser";
import { framesOf } from "./frames";
import type { ChatStream, ChatTurnResult, JsonOptions } from "./types";

/**
 * The JSON turn: one non-streaming pass, then validation and repair.
 *
 * Streaming is impossible here by construction — the structured value only
 * exists once the whole object parses — so the frames are synthesized after the
 * fact. A caller that needs live tokens cannot have them together with a
 * validated object, and asking for both would silently give up the schema.
 *
 * The stored transcript keeps the model's raw text, not the parsed object:
 * later turns replay it verbatim, and a re-serialized object would lose the
 * model's own formatting and any fields the schema discarded.
 */
export async function runJsonTurn<TStructured>(args: {
  loopOptions: ToolLoopOptions;
  client: ToolLoopClient;
  chat: Chat;
  model: string;
  messages: readonly ChatCompletionMessageParam[];
  json: JsonOptions & { schema: z.ZodType };
  trace: TraceCollector<Record<string, unknown>>;
  finish: (
    status: TerminalStatus,
    extra: { error?: string; structured?: TStructured },
  ) => Promise<ChatTurnResult<TStructured>>;
  conversationId: number | undefined;
}): Promise<ChatStream<TStructured>> {
  const {
    loopOptions,
    client,
    chat,
    model,
    messages,
    json,
    trace,
    finish,
    conversationId,
  } = args;

  const completion: ChatCompletion = await executeToolLoop({
    ...loopOptions,
    stream: false,
    body: { ...loopOptions.body, response_format: { type: "json_object" } },
  });

  const raw = completion.choices.at(0)?.message.content ?? "";

  const structured = await llmSchemaParser(json.schema, completion, {
    agent: "agent",
    messages,
    ...(json.schemaName === undefined ? {} : { schemaName: json.schemaName }),
    ...(json.maxRetries === undefined ? {} : { maxRetries: json.maxRetries }),
    ...(json.includeSchemaInPrompt === undefined
      ? {}
      : { includeSchemaInPrompt: json.includeSchemaInPrompt }),
    retry: (request) =>
      client.chat.completions.create({
        model,
        messages: request.messages,
        temperature: chat.temperature,
        max_tokens: chat.maxTokens,
        stream: false,
        ...(request.response_format === undefined
          ? {}
          : { response_format: request.response_format }),
      }),
  });

  if (raw !== "") trace.apply({ type: "chunk", text: raw });

  const result = await finish("finished", {
    structured: structured as TStructured,
  });

  return {
    frames: framesOf([
      { type: "init", conversationId },
      ...(raw === "" ? [] : [{ type: "chunk", text: raw }]),
      { type: "done" },
    ]),
    done: Promise.resolve(result),
  };
}
