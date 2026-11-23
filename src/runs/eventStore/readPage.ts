import { redisStreams } from "./backend";
import { readMemoryPage } from "./memory";
import { readRedisPage } from "./redis";
import { FIRST_ID, REPLAY_BATCH, type EventPage } from "./shared";

/**
 * Reads one bounded page of a run's log strictly after `afterId`.
 *
 * `count` defaults to `REPLAY_BATCH` so a replay of a long run arrives in pages
 * instead of one enormous array; pass a bigger value when re-reading in-loop.
 */
export async function readPage(
  runId: string,
  afterId: string = FIRST_ID,
  count = REPLAY_BATCH,
): Promise<EventPage> {
  const redis = redisStreams();
  if (!redis) return readMemoryPage(runId, afterId, count);
  return readRedisPage(redis, runId, afterId, count);
}
