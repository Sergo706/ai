import path from "node:path";

import { run } from "@riavzon/utils/server";

const SERVICE_ROOT = path.resolve(import.meta.dirname, "..");
const COMPOSE_FILE = path.join(SERVICE_ROOT, "docker-compose.test.yaml");

export const TEST_PORTS = {
  postgres: 5435,
  redis: 6381,
} as const;

export const TEST_PG_URL = `postgres://ai:ai@127.0.0.1:${String(TEST_PORTS.postgres)}/ai_test`;
export const TEST_REDIS_URL = `redis://127.0.0.1:${String(TEST_PORTS.redis)}/0`;

const compose = (args: string): string =>
  `docker compose -f "${COMPOSE_FILE}" ${args}`;

async function dockerAvailable(): Promise<boolean> {
  try {
    await run("docker info --format '{{.ServerVersion}}'");
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  label: string,
  probe: () => Promise<boolean>,
  { attempts = 60, intervalMs = 1_000 } = {},
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (await probe()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(
    `${label} did not become ready after ${String(attempts)} attempts${detail}`,
  );
}

async function isPostgresReady(): Promise<boolean> {
  const out = await run("docker exec ai-test-postgres pg_isready -U ai -d ai_test");
  return String(out.stdout).includes("accepting connections");
}

async function isRedisReady(): Promise<boolean> {
  const out = await run("docker exec ai-test-redis redis-cli ping");
  return String(out.stdout).trim() === "PONG";
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!(await dockerAvailable())) {
    throw new Error(
      "The integration project needs Docker: it starts PostgreSQL (pgvector) " +
        "and Redis from docker-compose.test.yaml. Start Docker and re-run, or " +
        "run the `units` project only.",
    );
  }

  await run(compose("up -d --wait postgres-test redis-test"), {
    cwd: SERVICE_ROOT,
  });

  await waitFor("PostgreSQL (test)", isPostgresReady);
  await waitFor("Redis (test)", isRedisReady);

  return async () => {
    await run(compose("down -v --remove-orphans"), {
      cwd: SERVICE_ROOT,
    }).catch(() => {
      // Teardown must never fail a green run.
    });
  };
}
