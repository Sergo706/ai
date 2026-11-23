import { redisStreams } from "./backend";
import { touchMemory } from "./memory";
import { touchRedis } from "./redis";

/**
 * Refreshes the TTL while the run is working but silent.
 *
 * The tail loop calls this on every idle round so a long-running but quiet run
 * does not lose its log to the TTL before its reader reconnects.
 */
export async function touchStream(runId: string): Promise<void> {
  const redis = redisStreams();
  if (!redis) {
    touchMemory(runId);
    return;
  }
  await touchRedis(redis, runId);
}
