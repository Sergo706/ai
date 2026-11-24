import type { StoredEvent } from "../../types/Chat";
import { redisStreams } from "./backend";
import { appendMemory } from "./memory";
import { appendRedis } from "./redis";

/**
 * Append one event to a run's log.
 *
 * Stores in Redis when one is configured and in process memory otherwise. The
 * caller serialises appends per run, so a burst keeps its order.
 *
 * @param runId - The run to append to.
 * @param id - Cursor id for this event.
 * @param event - The event to store.
 */
export async function appendEvent(
  runId: string,
  id: string,
  event: StoredEvent,
): Promise<void> {
  const redis = redisStreams();
  if (!redis) {
    appendMemory(runId, id, event);
    return;
  }
  await appendRedis(redis, runId, id, event);
}
