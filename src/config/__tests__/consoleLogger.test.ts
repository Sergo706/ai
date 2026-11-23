import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consoleLogger } from "../configSchema.js";

/**
 * The default logger.
 *
 * `configSchema` uses `consoleLogger()` as the zod default, so a caller who
 * never passes a `logger` writes through this function. It is the last-resort
 * observability path, which makes it worth pinning: a wrong argument order here
 * means every unconfigured deployment logs `[object Object]`.
 */

let spies: {
  debug: ReturnType<typeof vi.spyOn>;
  info: ReturnType<typeof vi.spyOn>;
  warn: ReturnType<typeof vi.spyOn>;
  error: ReturnType<typeof vi.spyOn>;
};

beforeEach(() => {
  spies = {
    debug: vi.spyOn(console, "debug").mockImplementation(() => undefined),
    info: vi.spyOn(console, "info").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consoleLogger", () => {
  it("prefers the message over the object when both are given", () => {
    consoleLogger().warn({ runId: "r1" }, "the message");

    expect(spies.warn).toHaveBeenCalledWith("the message");
  });

  it("accepts a bare string as the whole line", () => {
    // Some call sites pass only a string; stringifying that would quote it.
    consoleLogger().info("plain text");

    expect(spies.info).toHaveBeenCalledWith("plain text");
  });

  it("JSON-serialises an object when no message is supplied", () => {
    consoleLogger().debug({ runId: "r1", count: 2 });

    expect(spies.debug).toHaveBeenCalledWith('{"runId":"r1","count":2}');
  });

  it("routes each level to its own console method", () => {
    const logger = consoleLogger();
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(spies.debug).toHaveBeenCalledWith("d");
    expect(spies.info).toHaveBeenCalledWith("i");
    expect(spies.warn).toHaveBeenCalledWith("w");
    expect(spies.error).toHaveBeenCalledWith("e");
  });

  it("appends the bindings only once a child added some", () => {
    const bindings = { component: "runs" };
    consoleLogger(bindings).warn("with bindings");

    expect(spies.warn).toHaveBeenCalledWith("with bindings", bindings);
  });

  it("merges a child's bindings over its parent's", () => {
    // A child inherits the parent scope and adds its own, so a nested logger
    // still reports who its root was.
    const logger = consoleLogger({ component: "runs" }).child({ runId: "r1" });
    logger.error("nested");

    expect(spies.error).toHaveBeenCalledWith("nested", {
      component: "runs",
      runId: "r1",
    });
  });
});
