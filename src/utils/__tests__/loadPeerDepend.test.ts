import { describe, expect, it, vi } from "vitest";

import { loadPeer } from "~/utils/loadPeerDepend.js";

describe("loadPeer", () => {
  it("returns the real module when the peer is installed", async () => {
    const peer = await loadPeer<typeof import("zod")>("zod", "some feature");

    expect(typeof peer.z.object).toBe("function");
  });

  it("returns the exact same namespace a static import would", async () => {
    const viaHelper = await loadPeer<typeof import("zod")>("zod", "x");
    const viaStatic = await import("zod");

    expect(viaHelper).toBe(viaStatic);
    expect(viaHelper.z).toBe(viaStatic.z);
  });

  it("resolves a subpath the same way a static import does", async () => {
    const peer = await loadPeer<Record<string, unknown>>(
      "node:path",
      "some feature",
    );

    expect(typeof peer.join).toBe("function");
    expect((peer.join as (...parts: string[]) => string)("a", "b")).toBe("a/b");
  });

  it("names the package and the feature when the peer is missing", async () => {
    await expect(
      loadPeer("@riavzon/definitely-not-installed", "the widget tool"),
    ).rejects.toThrow(
      'Optional dependency "@riavzon/definitely-not-installed" is required for the widget tool. Install it with: npm install @riavzon/definitely-not-installed',
    );
  });

  it("keeps the resolution failure as the cause", async () => {
    expect.assertions(3);

    try {
      await loadPeer("@riavzon/definitely-not-installed", "the widget tool");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("Error");
      const cause = (err as Error).cause;
      expect(cause).toBeInstanceOf(Error);
    }
  });

  it("does not swallow a module whose own top level throws", async () => {
    vi.doMock("node:fs", () => {
      throw new Error("boom from the peer body");
    });

    try {
      await expect(
        loadPeer<Record<string, unknown>>("node:fs", "reading files"),
      ).rejects.toThrow(/node:fs/);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});
