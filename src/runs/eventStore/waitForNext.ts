import { redisStreams } from "./backend";
import { waitForMemoryNext } from "./memory";
import { waitForRedisNext } from "./redis";
import type { EventPage } from "./shared";

/**
 * Blocks until a new event arrives, the block times out, or the log is gone.
 *
 * Returning `null` on timeout rather than looping forever is deliberate: it
 * hands control back to the caller, which re-checks whether the response was
 * closed. A blocked read would otherwise be an unkillable task holding a dead
 * connection open.
 */
export async function waitForNext(
  runId: string,
  afterId: string,
): Promise<EventPage | null> {
  const redis = redisStreams();
  if (!redis) return waitForMemoryNext(runId, afterId);
  return waitForRedisNext(redis, runId, afterId);
}
