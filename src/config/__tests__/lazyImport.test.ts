import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { libLogger } from "~~/test/test-utils/logger.js";

/**
 * Verifies that importing the package entry point (`src/main.ts`) does not
 * read `getConfiguration()` at module evaluation time, and that lazy getters
 * observe values supplied later via `configuration()`.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("lazy configuration resolution on package import", () => {
  it("imports main.ts before configuration() is called and applies runs overrides afterwards", async () => {
    vi.resetModules();

    // Importing the full public entry point before `configuration()` must not
    // throw "Configuration not initialized".
    const main = await import("~/main.js");
    expect(typeof main.configuration).toBe("function");
    expect(typeof main.getLeaseTtlMs).toBe("function");

    const dir = mkdtempSync(join(tmpdir(), "ai-lazy-import-"));
    tempDirs.push(dir);
    const openAiConfig = new OpenAI({
      apiKey: "test-key",
      baseURL: "http://127.0.0.1:1/v1",
    });

    await main.configuration({
      db: join(dir, "lazy.sqlite"),
      redis: "memory",
      openAiConfig,
      embeddingConfig: {
        dimensions: 8,
        matchingModel: "test-match",
        retrievalModel: "test-retrieve",
      },
      logger: libLogger,
      runs: {
        leaseTtlMs: 20_000,
        heartbeatIntervalMs: 12_000,
        registry: { retainFinishedMs: 45_000 },
        eventStore: {
          maxStreamLen: 250,
          ttlSeconds: 120,
          blockMs: 2_500,
          replayBatch: 50,
        },
        recovery: {
          sweepIntervalMs: 3_000,
          maxAdoptPerSweep: 7,
          maxResumeAttempts: 4,
          unclaimedGraceMs: 15_000,
        },
      },
    });

    try {
      expect(main.getLeaseTtlMs()).toBe(20_000);
      // Clamped to half the lease TTL (10_000 < 12_000).
      expect(main.getHeartbeatIntervalMs()).toBe(10_000);
      expect(main.getMaxStreamLen()).toBe(250);
      expect(main.getStreamTtlSeconds()).toBe(120);
      expect(main.getBlockMs()).toBe(2_500);
      expect(main.getReplayBatch()).toBe(50);
      expect(main.getMaxResumeAttempts()).toBe(4);
      expect(main.getRunRecoverySettings()).toEqual({
        sweepIntervalMs: 3_000,
        maxAdoptPerSweep: 7,
        maxResumeAttempts: 4,
        unclaimedGraceMs: 15_000,
      });
    } finally {
      const { getDb } = await import("~/config/config.js");
      await getDb().destroy();
    }
  });
});
