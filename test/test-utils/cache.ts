import { MiniCache } from "@riavzon/utils";

/**
 * Empties the storage the library is currently configured with.
 *
 * The configured store lives in a module-level global, so it outlives an
 * individual test. A suite that asserts on cache behaviour must start from a
 * known-empty cache, and this is the only handle that reaches the real one
 * rather than a stand-in.
 *
 * A real Redis cannot be "cleared" without risking unrelated keys, so this only
 * acts on `MiniCache`; a Redis-backed suite should use a dedicated database
 * index and flush that instead.
 */
export function clearConfiguredCache(
  store: unknown,
): { cleared: boolean; kind: "memory" | "redis" } {
  if (store instanceof MiniCache) {
    store.clear();
    return { cleared: true, kind: "memory" };
  }
  return { cleared: false, kind: "redis" };
}
