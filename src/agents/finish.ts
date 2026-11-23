import { persistChatRun } from "../models/persistChatRun";
import { releaseRun } from "../models/runLease";
import { saveAssistantMessage } from "../models/saveMessages";
import { publish, scheduleDisposal } from "../runs/runRegistry";
import type { RunHandle, TerminalStatus } from "../runs/types";
import type { TraceCollector } from "../chat/traceCollector";
import type { ChatTurnResult } from "./types";

/**
 * Resolves a turn's result and writes it where the run system expects.
 *
 * Runs-on and runs-off differ in one place: a managed turn persists the
 * assistant message together with its run row, so a recovery sweep can tell
 * which messages belong to it. Both paths return the same shape, which is what
 * lets a caller stream either without branching.
 */
export function buildFinisher<TStructured>(args: {
  run: RunHandle | undefined;
  conversationId: number | undefined;
  registry: { usedTools: ReadonlySet<string> };
  trace: TraceCollector<Record<string, unknown>>;
}): (
  status: TerminalStatus,
  extra: { error?: string; structured?: TStructured },
) => Promise<ChatTurnResult<TStructured>> {
  const { run, conversationId, registry, trace } = args;

  return async (status, extra) => {
    const text = trace.fullResponse;
    const traceValue = trace.toTrace();

    if (run !== undefined && conversationId !== undefined) {
      await persistChatRun({
        runId: run.id,
        conversationId,
        trace,
        toolsUsed: registry.usedTools,
        status,
        ...(extra.error === undefined ? {} : { error: extra.error }),
      });
      publish(run, { type: "done" });
      scheduleDisposal(run);
      await releaseRun(run.id).catch(() => {
        // A cleanup write must not turn a finished run into a failure.
      });
    } else if (conversationId !== undefined && text !== "") {
      await saveAssistantMessage({
        conversationId,
        content: text,
        toolsUsed: [...registry.usedTools],
        trace: traceValue,
      });
    }

    return {
      runId: run?.id,
      conversationId,
      text,
      toolsUsed: [...registry.usedTools],
      trace: traceValue,
      cached: false,
      ...(extra.structured === undefined
        ? {}
        : { structured: extra.structured }),
      ...(extra.error === undefined ? {} : { error: new Error(extra.error) }),
    };
  };
}
