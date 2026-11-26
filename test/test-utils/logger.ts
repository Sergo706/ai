import { vi } from "vitest";
import type { Mock } from "vitest";

import type { Logger } from "../../src/config/configSchema";

/** The four spies a logger fixture exposes, named so emit stays portable. */
export type LoggerSpies = Record<"debug" | "info" | "warn" | "error", Mock>;

/**
 * The logger the library actually writes through.
 *
 * Production modules take their logger from `getConfiguration().logger`, not
 * from a call argument, so a test cannot observe logging unless the *config*
 * carries a spy. `test/units.setup.ts` installs this instance, which makes
 * `libLog.warn` assertable from any suite without re-plumbing configuration.
 */
const sharedSpies = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

export const libLog: LoggerSpies = sharedSpies;

export const libLogger: Logger = {
  ...sharedSpies,
  child: () => libLogger,
};

/** Clears the shared spies; called from the setup file between tests. */
export function resetLibLogger(): void {
  for (const spy of Object.values(sharedSpies)) spy.mockClear();
}

/**
 * A logger whose calls can be asserted, for modules that *do* take a logger
 * parameter.
 *
 * `child` returns the same object so a `.child({...})` chain stays observable
 * from the same spies.
 */
export function makeSpyLogger(): { logger: Logger; spies: LoggerSpies } {
  const own = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const logger: Logger = {
    ...own,
    child: () => logger,
  };

  return { logger, spies: own };
}

/** A logger that discards everything, for tests that only care about output. */
export function silentLogger(): Logger {
  const noop = (): void => {
    // silent.
  };
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
