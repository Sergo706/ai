import { beforeEach, describe, expect, it, vi } from "vitest";

import { libLogger, resetLibLogger } from "~~/test/test-utils/logger.js";

const h = vi.hoisted(() => ({
  markStaleRunsInterrupted: vi.fn<() => Promise<number>>(),
  startRunRecovery: vi.fn<() => () => void>(),
  listRunResumers: vi.fn<() => { kind: string }[]>(() => []),
}));

vi.mock("../../config/config.js", () => ({
  getConfiguration: () => ({ logger: libLogger }),
}));

vi.mock("../../models/runLease.js", () => ({
  INSTANCE_ID: "boot-test:1:0",
  markStaleRunsInterrupted: h.markStaleRunsInterrupted,
}));

vi.mock("../resumerRegistry.js", () => ({
  listRunResumers: h.listRunResumers,
}));

vi.mock("../runRecovery.js", () => ({
  startRunRecovery: h.startRunRecovery,
}));

const { startRuns } = await import("../boot.js");

beforeEach(() => {
  resetLibLogger();
  h.markStaleRunsInterrupted.mockReset();
  h.startRunRecovery.mockReset();
  h.listRunResumers.mockReset();
  h.listRunResumers.mockReturnValue([]);
});

describe("startRuns", () => {
  it("never starts recovery when stop() is called before reconciliation settles", async () => {
    let resolveReconcile!: (count: number) => void;
    h.markStaleRunsInterrupted.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveReconcile = resolve;
        }),
    );
    const stopRecovery = vi.fn();
    h.startRunRecovery.mockReturnValue(stopRecovery);

    const stop = startRuns();
    // Stop immediately while markStaleRunsInterrupted() is still pending.
    stop();

    resolveReconcile(2);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.startRunRecovery).not.toHaveBeenCalled();
    expect(stopRecovery).not.toHaveBeenCalled();
  });

  it("stops the recovery sweeper when stop() is called after reconciliation finishes", async () => {
    h.markStaleRunsInterrupted.mockResolvedValue(0);
    const stopRecovery = vi.fn();
    h.startRunRecovery.mockReturnValue(stopRecovery);

    const stop = startRuns();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.startRunRecovery).toHaveBeenCalledTimes(1);
    expect(stopRecovery).not.toHaveBeenCalled();

    stop();
    expect(stopRecovery).toHaveBeenCalledTimes(1);
  });
});
