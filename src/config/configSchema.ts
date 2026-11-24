import z from "zod";
import type Redis from "ioredis";
import type { Pool } from "pg";
import type OpenAI from "openai";



const redis = z.custom<Redis>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { duplicate?: unknown }).duplicate === "function" &&
    typeof (value as { pipeline?: unknown }).pipeline === "function" &&
    typeof (value as { xadd?: unknown }).xadd === "function",
  { message: "Expected an ioredis client" },
);


const pg = z.custom<Pool>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { connect?: unknown }).connect === "function" &&
    typeof (value as { query?: unknown }).query === "function",
  { message: "Expected a pg Pool instance" },
);
const sqlitePath = z.string().default(process.cwd())

const openai = z.custom<OpenAI>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { chat?: unknown }).chat === "object" &&
    typeof (
      value as { chat?: { completions?: { create?: unknown } } }
    ).chat?.completions?.create === "function",
  { message: "Expected an OpenAI client instance" },
);

/**
 * The logger the package writes through.
 *
 * Any object with these five methods works; pass one to `configuration()`. A
 * pino instance satisfies it as-is.
 */
export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * A `Logger` that writes to `console`.
 *
 * Useful as a default and in tests; swap it for a real logger in production.
 *
 * @param bindings - Fields added to every line, e.g. `{ service: "api" }`.
 * @returns A logger whose `child()` merges more bindings.
 * @example
 * ```ts
 * const logger = consoleLogger({ service: "api" });
 * logger.info({ userId }, "turn started");
 * ```
 */
export function consoleLogger(
  bindings: Record<string, unknown> = {},
): Logger {
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (obj: unknown, msg?: string) => {
      const text = msg ?? (typeof obj === "string" ? obj : JSON.stringify(obj));
      console[level](text, ...(Object.keys(bindings).length ? [bindings] : []));
    };

  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (add) => consoleLogger({ ...bindings, ...add }),
  };
}

const loggerSchema = z.custom<Logger>(
  (v) =>
    typeof v === "object" &&
    v !== null &&
    (["debug", "info", "warn", "error", "child"] as const).every(
      (k) => typeof (v as Record<string, unknown>)[k] === "function",
    ),
  { message: "logger must implement debug/info/warn/error/child" },
);


export const configSchema = z.object({
  /**
   * Cache backend: an ioredis client, or `"memory"` for a process-local cache.
   *
   * @default "memory"
   */
  redis: z.union([redis, z.literal("memory")]).default("memory"),
  /**
   * Where the tables live: a SQLite file path, or a `pg` `Pool`.
   *
   * A path gets migrations, WAL mode and `sqlite-vec` loaded automatically.
   */
  db: z.union([pg, sqlitePath]),
  /** The client used for every chat completion. */
  openAiConfig: openai,
  /** Embedding models and the vector width they return. */
  embeddingConfig: z.object({
    /** Embedding client, when it differs from `openAiConfig`. */
    client: openai.optional(),
    /** Vector width; must match what the models return. */
    dimensions: z.number().nonnegative(),
    /** Model used to embed queries for the semantic cache and retrieval. */
    matchingModel: z.string(),
    /** Model used to embed documents for storage. */
    retrievalModel: z.string(),
  }),
  /**
   * Where the package logs. Defaults to a console logger.
   *
   * @default consoleLogger()
   */
  logger: loggerSchema.default(consoleLogger()),
    extractor: z.object({
      ytDlpBin: z.string().optional(),
      whisperCppBin: z.string().optional(),
      whisperCppModelPath: z.string().optional(),
      disableLocalWhisper: z.boolean().default(false),
      /** Bodies below this many characters count as empty and fall through. */
      minContentCharacters: z.number().int().min(1).default(80),
      /** Per-URL HTTP budget. Media transcription legitimately takes minutes. */
      timeoutMs: z.number().int().min(1).default(120_000),
      /** Wall-clock cap for one URL, transcription included. 0 disables it. */
      deadlineMs: z.number().int().min(0).default(0),
      /** Upper bound handed downstream. `Infinity` is the shipped default. */
      maxCharacters: z.number().positive().default(Number.POSITIVE_INFINITY),
      /** Bodies below this skip the LLM summarisation entirely. */
      llmMinCharacters: z.number().int().min(1).default(4_000),
      /** Sampling temperature for the summarisation call. */
      llmTemperature: z.number().min(0).max(2).default(0.2),
      /** Model used to condense an extracted body. */
      llmModel: z.string().default("deepseek-flash"),
      /** Default summary length preset when a call does not pick one. */
      llmLength: z
        .enum(["short", "medium", "long", "xl", "xxl"])
        .default("medium"),
    }).optional().prefault({}),
    /**
     * Run-lease tuning. These are the defaults the `RUNS_*` environment
     * variables fall back to, so the lease can be configured without env vars.
     */
    runs: z.object({
      /** How long a claim stays valid without a heartbeat. */
      leaseTtlMs: z.number().int().min(5_000).default(60_000),
      /** How often a live run refreshes `claimed_at`; clamped to half the TTL. */
      heartbeatIntervalMs: z.number().int().min(1_000).default(15_000),
      /**
       * Defaults for the in-process run registry.
       *
       * The event cap is not here on purpose: the registry keeps the same number
       * of events as the event store, because a
       * reader that reattaches must get the same replay window from either copy.
       */
      registry: z.object({
        /**
         * How long a finished run stays readable from the local handle.
         *
         * Clamped to the stream TTL at startup: keeping the local copy past the
         * durable one would gain nothing and leak memory.
         */
        retainFinishedMs: z.number().int().min(0).default(600_000),
      }).prefault({}),
      /** Defaults for the run event log */
      eventStore: z.object({
        /** Events kept per run before the oldest are trimmed. */
        maxStreamLen: z.number().int().min(100).default(5_000),
        /** How long a finished run's log survives for late readers. */
        ttlSeconds: z.number().int().min(60).default(3_600),
        /** One tail wait before the reader re-checks for closure. */
        blockMs: z.number().int().min(1_000).default(15_000),
        /** Page size when replaying a long log. */
        replayBatch: z.number().int().min(1).default(500),
      }).prefault({}),
      /** Defaults for the recovery sweep (`runs/runRecovery.ts`). */
      recovery: z.object({
        /**
         * How often to look for abandoned runs.
         *
         * `0` derives it from the lease as `max(1000, leaseTtlMs / 2)`, which is
         * the shipped behaviour: fast enough that a crash is noticed promptly,
         * slow enough that a rolling deploy does not scan constantly. Set it
         * explicitly for tests, which use a sub-second lease.
         */
        sweepIntervalMs: z.number().int().min(0).default(0),
        /** Runs one sweep will try to adopt, so a mass crash cannot stampede. */
        maxAdoptPerSweep: z.number().int().min(1).default(3),
        /** Resumes allowed per run after its owner died. */
        maxResumeAttempts: z.number().int().min(0).default(5),
        /** Grace period before a row with no registered runner is closed. */
        unclaimedGraceMs: z.number().int().min(0).default(600_000),
      }).prefault({}),
    }).prefault({}),
})

/** The configuration after defaults are applied. */
export type Configuration = z.infer<typeof configSchema>;

/**
 * The configuration you pass to `configuration()`.
 *
 * Every field except `db`, `openAiConfig` and `embeddingConfig` has a default,
 * so a local setup can be as small as those three.
 */
export type ConfigurationInput = z.input<typeof configSchema>;