import type { PumpRunArgs, RunHandle, RunHandleInit, TerminalStatus } from "./types";
import {
  appendEvent,
  MAX_STREAM_LEN,
  nextId,
  STREAM_TTL_SECONDS,
} from "./eventStore";
import { StoredEvent } from "../types/Chat";
import { envInt } from "@riavzon/utils/server";
import { getConfiguration } from "../config/config";

const runs = new Map<string, RunHandle>();
const MAX_EVENTS = MAX_STREAM_LEN;

/**
 * How long a settled run stays readable from the local handle.
 *
 * Clamped to the stream TTL: a local copy outliving the durable log would be
 * strictly worse than the store, and it would keep the event array alive.
 */
const RETAIN_FINISHED_MS = Math.min(
  envInt(
    "RUNS_RETAIN_FINISHED_MS",
    getConfiguration().runs.registry.retainFinishedMs,
    { min: 0 },
  ),
  STREAM_TTL_SECONDS * 1_000,
);

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

export function getRun(id: string): RunHandle | undefined {
  return runs.get(id);
}

/**
 * Registers a live run.
 *
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

export function forgetRun(id: string): void {
  runs.delete(id);
}

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
 * Records one event, mirrors it into Redis, and forwards it to every attached
 * client.
 *
 * There are now two copies of the log on purpose. The in-memory array is the
 * fast path for readers in this process; the Redis Stream in `eventStore.ts` is
 * what a reader on another replica attaches to. Keeping the array means a
 * same-process reader does not pay a round-trip per chunk, and keeping the
 * stream means no reader has to care which replica served the original request.
 *
 * `appendEvent` is fire-and-forget and ordered through `enqueueAppend`, so a
 * Redis outage degrades cross-replica attach without failing the run.
 *
 * The id is assigned here, once, so both copies share one cursor space. A
 * client can therefore replay from this handle, lose the connection, reattach
 * to another replica and pass the last id it saw — the store will resolve it.
 */
export function publish(run: RunHandle, event: StoredEvent): void {
  const id = nextId(run.lastMintedId ?? run.eventIds.at(-1));
  run.lastMintedId = id;
  run.eventIds.push(id);
  run.events.push(event);
  if (run.events.length > MAX_EVENTS) {
    const excess = run.events.length - MAX_EVENTS;
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

export function scheduleDisposal(run: RunHandle): void {
  const timer = setTimeout(() => {
    forgetRun(run.id);
  }, RETAIN_FINISHED_MS);
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
 * Drains the agent loop independently of any HTTP response.
 *
 * This is what makes a run survive the browser going away: the loop's lifetime
 * is the pump's lifetime, not the response's. Closing the laptop removes a
 * subscriber; it does not abort anything.
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
