import type { TraceCollector } from "../chat/traceCollector";
import type { TerminalStatus } from "../runs/types";
import { saveAssistantMessage } from "./saveMessages";
import { updateRun } from "./runs";

export interface PersistChatRunArgs {
  runId: string;
  conversationId: number;
  trace: TraceCollector;
  toolsUsed: Iterable<string>;
  status: TerminalStatus;
  error?: string;
}

/**
 * Writes the assistant message and the matching `runs` row.
 *
 * Called from the pump's `finally`, so an aborted or failed run still keeps
 * whatever it produced — which is the difference between the user finding a
 * partial answer and an empty screen.
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
