import { redisStreams } from "./backend";
import { touchMemory } from "./memory";
import { touchRedis } from "./redis";

/**
 * Refresh a run's stream TTL while the run is working but silent.
 *
 * @param runId - The run to keep alive.
 */
export async function touchStream(runId: string): Promise<void> {
  const redis = redisStreams();
  if (!redis) {
    touchMemory(runId);
    return;
  }
  await touchRedis(redis, runId);
}
