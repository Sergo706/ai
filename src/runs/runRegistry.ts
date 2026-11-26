import type {
  PumpRunArgs,
  RunHandle,
  RunHandleInit,
  TerminalStatus,
} from "./types";
import {
  appendEvent,
  getMaxStreamLen,
  getStreamTtlSeconds,
  nextId,
} from "./eventStore";
import { StoredEvent } from "../types/Chat";
import { envInt } from "@riavzon/utils/server";
import { getConfiguration } from "../config/config";

const runs = new Map<string, RunHandle>();

/**
 * How long a settled run stays readable from the local handle.
 *
 * Clamped to the stream TTL: a local copy outliving the durable log would be
 * strictly worse than the store, and it would keep the event array alive.
 */
function getRetainFinishedMs(): number {
  return Math.min(
    envInt(
      "RUNS_RETAIN_FINISHED_MS",
      getConfiguration().runs.registry.retainFinishedMs,
      { min: 0 },
    ),
    getStreamTtlSeconds() * 1_000,
  );
}

/**
 * A per-run serial queue for Redis appends.
 *
 * `publish` is synchronous because the agent's `emit` callback is, but `XADD`
 * is not — and firing them unordered would let a `chunk` land in the stream
 * before the `tool_end` that preceded it. Chaining one promise per run keeps
 * append order identical to publish order without making `publish` async.
 */
const appendQueues = new Map<string, Promise<void>>();

function enqueueAppend(runId: string, id: string, event: StoredEvent): void {
  const previous = appendQueues.get(runId) ?? Promise.resolve();
  const next = previous
    .then(() => appendEvent(runId, id, event))
    .catch(() => {
      // The stream is a cross-replica convenience, not the source of truth.
      // A Redis hiccup must never break the run or the local subscriber fan-out.
    });
  appendQueues.set(runId, next);
  void next.then(() => {
    if (appendQueues.get(runId) === next) appendQueues.delete(runId);
  });
}

/**
 * Read a run this process is currently holding.
 *
 * @param id - The run id.
 * @returns The handle, or `undefined` when this replica does not hold it.
 */
export function getRun(id: string): RunHandle | undefined {
  return runs.get(id);
}

/**
 * Register a live run so it can be streamed, aborted and reattached to.
 *
 * @param init - The run's identity; log arrays, subscribers and the controller
 * are created here.
 * @param seedAfterId - Cursor the run continues from, when resuming.
 * @returns The registered handle.
 */
export function registerRun(
  init: RunHandleInit,
  seedAfterId?: string,
): RunHandle {
  const handle: RunHandle = {
    events: [],
    eventIds: [],
    controller: new AbortController(),
    subscribers: new Set(),
    ...init,
  };
  if (seedAfterId !== undefined) handle.lastMintedId = seedAfterId;
  runs.set(handle.id, handle);
  return handle;
}

/**
 * Drop a run's handle so it stops being streamable from this process.
 *
 * @param id - The run id.
 */
export function forgetRun(id: string): void {
  runs.delete(id);
}

/** Every run this process is holding. */
export function listRuns(): RunHandle[] {
  return [...runs.values()];
}

/** Runs visible to a conversation, newest first. Used by `GET /api/runs`. */
export function listRunsForConversation(conversationId: number): RunHandle[] {
  return [...runs.values()]
    .filter((run) => run.conversationId === conversationId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Record one event, mirror it into the event store, and forward it to every
 * attached reader.
 *
 * The cursor id is assigned once here so the in-memory copy and the stored copy
 * share one id space; a client can replay from either using the last id it saw.
 *
 * @param run - The run that emitted the event.
 * @param event - The event to record.
 */
export function publish(run: RunHandle, event: StoredEvent): void {
  const id = nextId(run.lastMintedId ?? run.eventIds.at(-1));
  run.lastMintedId = id;
  run.eventIds.push(id);
  run.events.push(event);
  const maxEvents = getMaxStreamLen();
  if (run.events.length > maxEvents) {
    const excess = run.events.length - maxEvents;
    run.events.splice(0, excess);
    run.eventIds.splice(0, excess);
  }
  enqueueAppend(run.id, id, event);
  for (const send of run.subscribers) {
    try {
      send(event, id);
    } catch {
      run.subscribers.delete(send);
    }
  }
}

/**
 * Keep a settled run readable for a while, then drop it.
 *
 * @param run - The run to dispose of.
 */
export function scheduleDisposal(run: RunHandle): void {
  const timer = setTimeout(() => {
    forgetRun(run.id);
  }, getRetainFinishedMs());
  timer.unref();
  run.disposal = () => {
    clearTimeout(timer);
    forgetRun(run.id);
  };
}

export function clearRuns(): void {
  for (const run of runs.values()) run.disposal?.();
  runs.clear();
}

/**
 * Drain the agent loop independently of any HTTP response.
 *
 * The loop's lifetime is the pump's, not the response's, which is what lets a
 * run survive the browser going away. Always persists a terminal status and
 * schedules disposal.
 *
 * @param args - The run, its event stream, trace and persist callback.
 */
export async function pumpRun(args: PumpRunArgs): Promise<void> {
  const { run, agent, trace, log, persist } = args;
  let status: TerminalStatus = "finished";
  let error: string | undefined;

  try {
    for await (const event of agent) {
      trace.apply(event);
      publish(run, event);
    }
    publish(run, { type: "done" });
  } catch (err) {
    if (run.controller.signal.aborted) {
      status = "aborted";
      publish(run, { type: "done" });
    } else {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
      log.error({ err, runId: run.id }, "Agent failure during detached run");
      publish(run, {
        type: "error",
        message: "The agent encountered an error and could not complete.",
      });
    }
  } finally {
    run.status = status;
    try {
      await persist(status, error);
    } catch (err) {
      log.error({ err, runId: run.id }, "Failed to persist the finished run");
    }
    scheduleDisposal(run);
  }
}
