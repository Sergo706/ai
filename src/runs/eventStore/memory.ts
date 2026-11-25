import { MiniCache } from "@riavzon/utils";
import type { StoredEvent } from "../../types/Chat";
import {
  FIRST_ID,
  getBlockMs,
  getMaxStreamLen,
  getStreamTtlSeconds,
  type EventPage,
} from "./shared";


const memoryLogs = new MiniCache<MemoryLog>(5_000);
const waiters = new Map<string, Set<() => void>>();

interface MemoryLog {
  ids: string[];
  events: StoredEvent[];
}


/**
 * Wake every reader parked on a run's log.
 *
 * @param runId - The run whose waiters should be woken.
 */
export function notifyMemory(runId: string): void {
  const set = waiters.get(runId);
  if (!set) return;
  for (const wake of set) wake();
}

/**
 * Forget every waiter for a run.
 *
 * @param runId - The run whose waiters should be dropped.
 */
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
 * Append one event to a run's in-memory log.
 *
 * Oldest events are trimmed once the log passes `MAX_STREAM_LEN`, and every
 * parked reader is woken.
 *
 * @param runId - The run to append to.
 * @param id - The event id, assigned by the caller.
 * @param event - The event to store.
 */
export function appendMemory(
  runId: string,
  id: string,
  event: StoredEvent,
): void {
  const log = readMemory(runId) ?? { ids: [], events: [] };
  log.ids.push(id);
  log.events.push(event);

  const maxStreamLen = getMaxStreamLen();
  if (log.events.length > maxStreamLen) {
    const excess = log.events.length - maxStreamLen;
    log.ids.splice(0, excess);
    log.events.splice(0, excess);
  }

  memoryLogs.set(runId, log, getStreamTtlSeconds() * 1_000);
  notifyMemory(runId);
}

/**
 * Read one bounded page of a run's log, strictly after `afterId`.
 *
 * @param runId - The run to read.
 * @param afterId - Cursor to resume from; `FIRST_ID` starts at the beginning.
 * @param count - Maximum events to return.
 * @returns The events plus the id to pass as `afterId` next time.
 */
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
 * The id of the newest event held for a run.
 *
 * @param runId - The run to inspect.
 * @returns The latest id, or `undefined` when the log is empty or expired.
 */
export function lastMemoryId(runId: string): string | undefined {
  return readMemory(runId)?.ids.at(-1);
}

/**
 * Wait for the next event, a short timeout, or the log disappearing.
 *
 * @param runId - The run to follow.
 * @param afterId - Cursor to resume from.
 * @returns The new page, or `null` when nothing arrived before the timeout.
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
    }, getBlockMs());

    set.add(wake);
    waiters.set(runId, set);
  });

  if (!woken) return null;
  const page = readMemoryPage(runId, afterId, Number.MAX_SAFE_INTEGER);
  return page.events.length === 0 ? null : page;
}

/**
 * Restart the expiry clock on a run's log.
 *
 * @param runId - The run to keep alive.
 */
export function touchMemory(runId: string): void {
  const log = readMemory(runId);
  if (log) memoryLogs.set(runId, log, getStreamTtlSeconds() * 1_000);
}

/**
 * Delete a run's log and release anyone waiting on it.
 *
 * @param runId - The run to drop.
 */
export function dropMemory(runId: string): void {
  memoryLogs.del(runId);
  notifyMemory(runId);
  clearMemoryWaiters(runId);
}
