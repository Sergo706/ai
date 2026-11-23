import type { StoredEvent } from "../../types/Chat";
import { redisStreams } from "./backend";
import { appendMemory } from "./memory";
import { appendRedis } from "./redis";

/**
 * Appends one event to a run's log.
 *
 * Redis when a client is configured, the process-local `MiniCache` otherwise.
 * Both are fire-and-forget from the caller's point of view: `runRegistry`
 * serializes appends per run and never blocks the agent on either one.
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
