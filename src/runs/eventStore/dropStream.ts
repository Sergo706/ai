import { redisStreams } from "./backend";
import { dropMemory } from "./memory";
import { dropRedis } from "./redis";

/**
 * Best-effort cleanup. A stream is disposable once its run has settled and its
 * TTL has passed; deleting it early would break a reader that attaches late.
 */
export async function dropStream(runId: string): Promise<void> {
  const redis = redisStreams();
  if (!redis) {
    dropMemory(runId);
    return;
  }
  await dropRedis(redis, runId);
}
