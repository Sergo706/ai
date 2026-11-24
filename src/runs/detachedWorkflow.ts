
import { workflowStream } from "../chat/sse.js";
import { publish, registerRun, scheduleDisposal } from "./runRegistry.js";
import type {
  DetachedWorkflow,
  DetachedWorkflowArgs,
  WorkflowStreamWithRegistryArgs,
} from "./types.js";


/**
 * Register a run so its frames can be streamed, replayed and aborted.
 *
 * Use the returned helpers rather than publishing directly: `tee` records every
 * frame, and `finish`/`fail` drive the run to a terminal state.
 *
 * @param args - The run's identity and logger.
 * @returns The handle plus `tee`, `finish` and `fail`.
 * @example
 * ```ts
 * const detached = attachDetachedWorkflow({ runId, kind: "workflow", log });
 * const emit = detached.tee(send);
 * detached.finish(result);
 * ```
 */
export function attachDetachedWorkflow(
  args: DetachedWorkflowArgs,
): DetachedWorkflow {
  const run = registerRun(
    {
      id: args.runId,
      kind: args.kind,
      conversationId: args.conversationId,
      startedAt: Date.now(),
      status: "running",
    },
    args.seedAfterId,
  );

  return {
    run,
    tee: (emit) => (frame) => {
      publish(run, frame);
      emit(frame);
    },
    finish: (result) => {
      publish(run, result);
      run.status = "finished";
      publish(run, { type: "done" });
      scheduleDisposal(run);
    },
    fail: () => {
      publish(run, { type: "error", message: "Server error please try again" });
      run.status = "failed";
      scheduleDisposal(run);
    },
  };
}

/**
 * Build the SSE response for a detached workflow, registered for replay.
 *
 * Owns the order that matters: the handle exists before the work starts, every
 * frame is published as well as written, and the run reaches a terminal state on
 * both paths, including after a throw.
 *
 * @param args - The run identity plus the work to execute.
 * @returns A `ReadableStream` to hand straight to a `Response`.
 */
export function workflowStreamWithRegistry(
  args: WorkflowStreamWithRegistryArgs,
): ReadableStream<Uint8Array> {
  return workflowStream({
    execute: async (emit) => {
      const detached = attachDetachedWorkflow({
        runId: args.runId,
        kind: args.kind,
        conversationId: args.conversationId,
        log: args.log,
      });

      try {
        const result = await args.execute({
          emit: detached.tee(emit),
          signal: detached.run.controller.signal,
        });
        detached.finish(result);
        return result;
      } catch (err) {
        detached.fail();
        throw err;
      }
    },
    onError: args.onError,
    heartbeatMs: args.heartbeatMs,
  });
}
