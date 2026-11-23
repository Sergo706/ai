process.env.NODE_ENV = "test";

/** Host ports published by `docker-compose.test.yaml`. */
const PORTS = { postgres: 5435, redis: 6381 } as const;

export const INTEGRATION_PG_URL = `postgres://ai:ai@127.0.0.1:${String(PORTS.postgres)}/ai_test`;
export const INTEGRATION_REDIS_URL = `redis://127.0.0.1:${String(PORTS.redis)}/15`;

/** Exposed so a suite can assert which services its fixtures point at. */
export const integrationTargets = {
  postgres: INTEGRATION_PG_URL,
  redis: INTEGRATION_REDIS_URL,
} as const;

/**
 * The integration project has no module-level configuration on purpose.
 *
 * Each suite calls `loadConfig()` from `test/test-utils/config.ts`, which drops
 * the module registry and then configures the backend that suite needs. A
 * global configuration would fight that, because `src/config/config.ts`
 * memoises its clients with `??=` and keeps the first one it is given.
 */
