import type { ChatCompletionMessageParam } from "openai/resources";
import { makeCompactionHandler } from "../chat/compaction";
import { compactHistory, historyToMessages } from "../chat/compactChat";
import type { CompactionState, HistoryMessage } from "../types/Compaction";
import type { ToolLoopClient } from "../types/ToolExecutionTypes";
import type { AgentConfig, ModelOptions } from "./types";

/**
 * Stored history - provider messages.
 *
 * Compaction runs only when the host configured it: it costs a summariser call
 * and a write, so an agent that never set a threshold must not pay for either.
 * The new watermark is persisted before the turn continues, because the
 * messages about to be sent are the compacted ones — losing the watermark would
 * make the next turn re-summarise the same span.
 */
export async function buildHistoryMessages(args: {
  history: HistoryMessage[];
  state: CompactionState;
  compaction: AgentConfig["compaction"];
  conversationId: number | undefined;
  client: ToolLoopClient;
  model: ModelOptions;
}): Promise<ChatCompletionMessageParam[]> {
  const { history, state, compaction, conversationId, client, model } = args;

  if (compaction === undefined) {
    return history.flatMap(historyToMessages);
  }

  const outcome = await compactHistory(history, state, compaction, (prompt) =>
    summarise(client, model, compaction, prompt),
  );

  if (conversationId !== undefined && outcome.update.changed) {
    await makeCompactionHandler(conversationId, {
      attempts: compaction.attempts,
    })(outcome.update);
  }

  return outcome.messages;
}

async function summarise(
  client: ToolLoopClient,
  model: ModelOptions,
  compaction: NonNullable<AgentConfig["compaction"]>,
  prompt: string,
): Promise<string> {
  const completion = await client.chat.completions.create({
    model: model.model,
    messages: [{ role: "user", content: prompt }],
    temperature: compaction.temperature,
    max_tokens: compaction.maxTokens,
    stream: false,
  });
  return completion.choices.at(0)?.message.content ?? "";
}
