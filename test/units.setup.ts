import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import OpenAI from "openai";
import { afterAll, beforeEach } from "vitest";

import { libLogger, resetLibLogger } from "./test-utils/logger";

process.env.NODE_ENV = "test";

/**
 * Several modules read `getConfiguration()` at import time — `models/runLease.ts`
 * derives its lease constants from it, for example — so a configuration has to
 * exist before the first test file imports anything. Doing it here rather than
 * in each suite keeps the setup honest: the unit project runs against a real
 * SQLite database with the real migrations, not a stub.
 *
 * The logger is a spy (`libLog`) because production code reads its logger from
 * the configuration rather than from a call argument, so assertions need the
 * *config* to carry one.
 *
 * Tests that need a *different* backend call `loadConfig()` from
 * `test/test-utils/config.ts`, which drops the module registry first and
 * therefore gets its own isolated instance.
 */
const tempDir = mkdtempSync(join(tmpdir(), "ai-units-"));

const { configuration, getDb } = await import("../src/config/config");

const offline = () =>
  new OpenAI({ apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" });

await configuration({
  db: join(tempDir, "units.db"),
  redis: "memory",
  openAiConfig: offline(),
  embeddingConfig: {
    client: offline(),
    dimensions: 8,
    matchingModel: "test-embedding",
    retrievalModel: "test-embedding",
  },
  logger: libLogger,
});

beforeEach(() => {
  resetLibLogger();
});

/**
 * Close the SQLite handle at the end of each test file.
 *
 * `better-sqlite3` keeps a native handle open for the life of the Kysely
 * instance, and a handle held after the last test makes the worker wait out the
 * full teardown timeout before it is killed — the process looks hung even
 * though every test has finished. Vitest runs this file once per test file, so
 * each file gets its own database and cleans it up.
 */
afterAll(async () => {
  await getDb().destroy();
  rmSync(tempDir, { recursive: true, force: true });
});
