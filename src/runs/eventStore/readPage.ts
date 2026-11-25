import { redisStreams } from "./backend";
import { readMemoryPage } from "./memory";
import { readRedisPage } from "./redis";
import { FIRST_ID, getReplayBatch, type EventPage } from "./shared";

/**
 * Read one bounded page of a run's log, strictly after `afterId`.
 *
 * @param runId - The run to read.
 * @param afterId - Cursor to continue from.
 * @default afterId FIRST_ID
 * @param count - Maximum events in this page.
 * @default count REPLAY_BATCH
 * @returns The page plus the cursor to request the next one.
 */
export async function readPage(
  runId: string,
  afterId: string = FIRST_ID,
  count: number = getReplayBatch(),
): Promise<EventPage> {
  const redis = redisStreams();
  if (!redis) return readMemoryPage(runId, afterId, count);
  return readRedisPage(redis, runId, afterId, count);
}
