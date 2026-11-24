import type { TraceCollector } from "../chat/traceCollector";
import type { TerminalStatus } from "../runs/types";
import { saveAssistantMessage } from "./saveMessages";
import { updateRun } from "./runs";

/** What to record for a finished turn. */
export interface PersistChatRunArgs {
  /** The run being completed. */
  runId: string;
  /** Conversation the message belongs to. */
  conversationId: number;
  /** Collected answer text, reasoning and tool steps. */
  trace: TraceCollector;
  /** Names of the tools the turn used. */
  toolsUsed: Iterable<string>;
  /** Final run status to record. */
  status: TerminalStatus;
  /** Failure message, when the turn did not succeed. */
  error?: string;
}

/**
 * Save the assistant message and update its run row.
 *
 * Also called for aborted and failed runs, so partial output is kept rather
 * than lost.
 *
 * @param args - The run to complete and what it produced.
 */
export async function persistChatRun(args: PersistChatRunArgs): Promise<void> {
  const { runId, conversationId, trace, toolsUsed, status, error } = args;
  const traceValue = trace.toTrace();

  let messageId: number | null = null;
  if (trace.fullResponse) {
    const saved = await saveAssistantMessage({
      conversationId,
      content: trace.fullResponse,
      toolsUsed: [...toolsUsed],
      trace: traceValue,
    });
    messageId = saved?.id ?? null;
  }

  await updateRun({
    id: runId,
    status,
    error: error ?? null,
    messageId,
    partial: {
      text: trace.fullResponse,
      trace: traceValue ?? undefined,
    },
    finished: true,
  });
}
