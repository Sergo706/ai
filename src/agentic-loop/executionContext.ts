// server/lib/agenticLoop/executionContext.ts
import type {
  WorkflowExecutionContext,
  WorkflowProgressEvent,
  WorkflowProgressUpdate,
  WorkflowStage,
} from "./types";

/** Where the loop forwards progress and cancellation from. */
export interface ProgressSink {
  workflow: string;
  signal?: AbortSignal;
  onProgress?: (event: WorkflowProgressEvent) => void;
}

/**
 * Thrown when the caller's `AbortSignal` fires mid-run.
 *
 * @example
 * ```ts
 * if (err instanceof WorkflowAbortedError) return; // caller cancelled
 * ```
 */
export class WorkflowAbortedError extends Error {
  constructor(workflow: string) {
    super(`${workflow} workflow aborted by caller`);
    this.name = "WorkflowAbortedError";
  }
}

/** Single check point used between stages and inside adapters. */
export function throwIfAborted(
  signal: AbortSignal | undefined,
  workflow = "workflow",
): void {
  if (signal?.aborted) throw new WorkflowAbortedError(workflow);
}

/**
 * Binds one stage to the caller's callback. Adapters receive the result and
 * only ever describe what they did; the workflow name and stage are filled in
 * here so every event is consistent.
 */
export function bindStage(
  sink: ProgressSink,
  stage: WorkflowStage,
): WorkflowExecutionContext {
  return {
    signal: sink.signal,
    emit: (update: WorkflowProgressUpdate) => {
      sink.onProgress?.({ workflow: sink.workflow, stage, ...update });
    },
  };
}
