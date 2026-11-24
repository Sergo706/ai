import { redisStreams } from "./backend";
import { dropMemory } from "./memory";
import { dropRedis } from "./redis";

/**
 * Delete a run's stored log.
 *
 * Best effort: delete only after the run has settled and its TTL has passed,
 * because deleting early breaks a reader that attaches late.
 *
 * @param runId - The run whose log to delete.
 */
export async function dropStream(runId: string): Promise<void> {
  const redis = redisStreams();
  if (!redis) {
    dropMemory(runId);
    return;
  }
  await dropRedis(redis, runId);
}
