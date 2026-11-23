import { MiniCache } from "@riavzon/utils";
import type { StoredEvent } from "../../types/Chat";
import {
  BLOCK_MS,
  FIRST_ID,
  MAX_STREAM_LEN,
  STREAM_TTL_SECONDS,
  type EventPage,
} from "./shared";


const memoryLogs = new MiniCache<MemoryLog>(5_000);
const waiters = new Map<string, Set<() => void>>();

interface MemoryLog {
  ids: string[];
  events: StoredEvent[];
}


/** Wakes every reader parked on this run. */
export function notifyMemory(runId: string): void {
  const set = waiters.get(runId);
  if (!set) return;
  for (const wake of set) wake();
}

/** Drops every waiter for a run, used when its log is deleted. */
export function clearMemoryWaiters(runId: string): void {
  waiters.delete(runId);
}

function readMemory(runId: string): MemoryLog | null {
  return memoryLogs.get(runId);
}

/** Index just after `afterId`, or 0 when the cursor is gone or is `FIRST_ID`. */
function memoryOffset(log: MemoryLog, afterId: string): number {
  if (afterId === FIRST_ID) return 0;
  const index = log.ids.indexOf(afterId);
  return index === -1 ? 0 : index + 1;
}

/**
 * Appends one event under the id the caller assigned, trimming the oldest past
 * `MAX_STREAM_LEN`.
 *
 * The id comes from the registry, not from here, so an in-process reader and a
 * store reader hold the same cursor for the same event.
 */
export function appendMemory(
  runId: string,
  id: string,
  event: StoredEvent,
): void {
  const log = readMemory(runId) ?? { ids: [], events: [] };
  log.ids.push(id);
  log.events.push(event);

  if (log.events.length > MAX_STREAM_LEN) {
    const excess = log.events.length - MAX_STREAM_LEN;
    log.ids.splice(0, excess);
    log.events.splice(0, excess);
  }

  memoryLogs.set(runId, log, STREAM_TTL_SECONDS * 1_000);
  notifyMemory(runId);
}

/** Reads one bounded page strictly after `afterId`. */
export function readMemoryPage(
  runId: string,
  afterId: string,
  count: number,
): EventPage {
  const log = readMemory(runId);
  if (!log) return { ids: [], events: [], lastId: afterId };

  const start = memoryOffset(log, afterId);
  const events = log.events.slice(start, start + count);
  const ids = log.ids.slice(start, start + events.length);
  const lastIndex = start + events.length - 1;
  return { ids, events, lastId: log.ids[lastIndex] ?? afterId };
}

/**
 * The id of the newest event this process holds for the run.
 */
export function lastMemoryId(runId: string): string | undefined {
  return readMemory(runId)?.ids.at(-1);
}

/**
 * Waits for a new event, the block timeout, or the log disappearing.
 *
 * Mirrors `XREAD BLOCK`: `null` means "nothing arrived, come back and check
 * whether the reader should stop".
 */
export async function waitForMemoryNext(
  runId: string,
  afterId: string,
): Promise<EventPage | null> {
  const pending = readMemory(runId);
  if (!pending) return null;

  if (memoryOffset(pending, afterId) < pending.events.length)
    return readMemoryPage(runId, afterId, Number.MAX_SAFE_INTEGER);

  const woken = await new Promise<boolean>((resolve) => {
    const set = waiters.get(runId) ?? new Set<() => void>();

    const wake = (): void => {
      clearTimeout(timer);
      set.delete(wake);
      resolve(true);
    };

    const timer = setTimeout(() => {
      set.delete(wake);
      resolve(false);
    }, BLOCK_MS);

    set.add(wake);
    waiters.set(runId, set);
  });

  if (!woken) return null;
  const page = readMemoryPage(runId, afterId, Number.MAX_SAFE_INTEGER);
  return page.events.length === 0 ? null : page;
}

/** Refreshes the TTL while the run is working but silent. */
export function touchMemory(runId: string): void {
  const log = readMemory(runId);
  if (log) memoryLogs.set(runId, log, STREAM_TTL_SECONDS * 1_000);
}

/** Deletes a run's log and wakes anyone parked on it. */
export function dropMemory(runId: string): void {
  memoryLogs.del(runId);
  notifyMemory(runId);
  clearMemoryWaiters(runId);
}
