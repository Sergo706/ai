import { redisStreams } from "./backend";
import { lastMemoryId } from "./memory";
import { lastRedisId } from "./redis";

/**
 * The id of the newest event already stored for a run.
 *
 * @param runId - The run to inspect.
 * @returns The cursor, or `undefined` when nothing is stored yet.
 */
export async function lastStreamId(runId: string): Promise<string | undefined> {
  const redis = redisStreams();
  if (!redis) return lastMemoryId(runId);
  return lastRedisId(redis, runId);
}
