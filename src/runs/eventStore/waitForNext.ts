import { redisStreams } from "./backend";
import { waitForMemoryNext } from "./memory";
import { waitForRedisNext } from "./redis";
import type { EventPage } from "./shared";

/**
 * Wait for the next event, or for the block to time out.
 *
 * @param runId - The run to wait on.
 * @param afterId - Cursor to read after.
 * @returns The new page, or `null` on timeout, which lets the caller re-check
 * whether its response was closed.
 */
export async function waitForNext(
  runId: string,
  afterId: string,
): Promise<EventPage | null> {
  const redis = redisStreams();
  if (!redis) return waitForMemoryNext(runId, afterId);
  return waitForRedisNext(redis, runId, afterId);
}
