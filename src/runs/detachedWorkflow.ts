
import { workflowStream } from "../chat/sse.js";
import { publish, registerRun, scheduleDisposal } from "./runRegistry.js";
import type {
  DetachedWorkflow,
  DetachedWorkflowArgs,
  WorkflowStreamWithRegistryArgs,
} from "./types.js";


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
 * The streaming response for a detached workflow, registered for replay.
 *
 * This is the single place the research-family routes get their SSE body from,
 * so they cannot drift on the three things that must happen in order: the handle
 * exists before the work starts, every frame is published as well as written,
 * and the registry reaches a terminal state on both paths — including after a
 * throw, where a run left `running` would look alive until its lease expired.
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
