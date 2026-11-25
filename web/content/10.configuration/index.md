---
title: Configuration
description: Initialize @riavzon/ai once at startup with configuration(), wire databases, Redis, OpenAI clients, loggers, extractor settings, and run-lease defaults.
navigation:
  icon: i-lucide-settings
seo:
  title: Configuration — Riavzon AI
  description: Complete reference for configuration(), ConfigurationInput, Configuration, getConfiguration(), and consoleLogger() in @riavzon/ai.
---

Call `await configuration(input)` once during server boot before creating agents, querying models, using cache helpers, or starting the Run System. Calling `configuration()` validates every option with Zod, initializes storage and Kysely connections, runs SQL migrations, and caches the resolved `Configuration` for the lifetime of the process.

## Minimal vs. full configuration

Only `db`, `openAiConfig`, and `embeddingConfig` are required. Every other field has a production-sensible default.

::tabs
  :::tabs-item{label="Minimal (Local SQLite)" icon="i-lucide-laptop"}
  ```ts [src/ai-config.ts]
  import OpenAI from "openai";
  import { configuration } from "@riavzon/ai";

  await configuration({
    db: "./data/app.db",
    openAiConfig: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    embeddingConfig: {
      dimensions: 1536,
      retrievalModel: "text-embedding-3-small",
      matchingModel: "text-embedding-3-small",
    },
  });
  ```
  :::

  :::tabs-item{label="Full Production (Postgres + Redis)" icon="i-lucide-server"}
  ```ts [src/ai-config.ts]
  import Redis from "ioredis";
  import OpenAI from "openai";
  import { Pool } from "pg";
  import pino from "pino";
  import { configuration } from "@riavzon/ai";

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const redis = new Redis(process.env.REDIS_URL!);
  const chatClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const embedClient = new OpenAI({
    apiKey: process.env.EMBED_API_KEY,
    baseURL: process.env.EMBED_BASE_URL,
  });

  await configuration({
    db: pool,
    redis,
    openAiConfig: chatClient,
    embeddingConfig: {
      client: embedClient,
      dimensions: 1536,
      retrievalModel: "text-embedding-3-small",
      matchingModel: "text-embedding-3-small",
    },
    logger: pino({ level: "info" }),
    extractor: {
      minContentCharacters: 80,
      timeoutMs: 120_000,
      deadlineMs: 0,
      maxCharacters: Number.POSITIVE_INFINITY,
      llmMinCharacters: 4_000,
      llmTemperature: 0.2,
      llmModel: "gpt-4o-mini",
      llmLength: "medium",
      disableLocalWhisper: false,
    },
    runs: {
      leaseTtlMs: 60_000,
      heartbeatIntervalMs: 15_000,
      registry: {
        retainFinishedMs: 600_000,
      },
      eventStore: {
        maxStreamLen: 5_000,
        ttlSeconds: 3_600,
        blockMs: 15_000,
        replayBatch: 500,
      },
      recovery: {
        sweepIntervalMs: 0, // 0 derives max(1000, floor(leaseTtlMs / 2))
        maxAdoptPerSweep: 3,
        maxResumeAttempts: 5,
        unclaimedGraceMs: 600_000,
      },
    },
  });
  ```
  :::
::

## `ConfigurationInput` reference

### Core options

::field-group
  :::field{name="db" type="Pool | string" required}
  Either a `pg.Pool` instance (PostgreSQL with `pgvector`) or a local SQLite file path string (automatically enables WAL mode, `synchronous = NORMAL`, `foreign_keys = ON`, loads `sqlite-vec`, and runs migrations).
  :::

  :::field{name="openAiConfig" type="OpenAI" required}
  Any `openai`-compatible SDK client (`chat.completions.create`) used for chat completions, compaction, and structured output repair.
  :::

  :::field{name="embeddingConfig" type="object" required}
  - `dimensions: number` — Vector width; verified at runtime on every embedding call and used by the initial migration.
  - `retrievalModel: string` — Model name for `generateEmbedding()` (document chunks).
  - `matchingModel: string` — Model name for `generateMatchingEmbedding()` (queries, semantic cache, adaptive dedupe).
  - `client?: OpenAI` — Optional separate OpenAI-compatible client for embeddings. Falls back to `openAiConfig` when omitted.
  :::

  :::field{name="redis" type="Redis | 'memory'" default="'memory'"}
  Pass an `ioredis` client for multi-replica Redis Streams, generated file downloads (`pdf_creator`, `create_styled_spreadsheet`), and shared caching. Defaults to an in-process `MiniCache`.
  :::

  :::field{name="logger" type="Logger" default="consoleLogger()"}
  Any logger implementing `{ debug, info, warn, error, child }` — a `pino` instance works directly. Use `consoleLogger({ service: "api" })` for structured console bindings.
  :::
::

### `extractor` options (optional)

Configure defaults for the built-in `extractor` (`extractor()`) tool:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `ytDlpBin` | `string` | `undefined` | Custom path to `yt-dlp` binary for media extraction. |
| `whisperCppBin` | `string` | `undefined` | Custom path to `whisper.cpp` binary for local transcription. |
| `whisperCppModelPath` | `string` | `undefined` | Path to a local Whisper model file. |
| `disableLocalWhisper` | `boolean` | `false` | Disables local Whisper transcription fallback. |
| `minContentCharacters` | `number` | `80` | Bodies shorter than this count as empty and fall through. |
| `timeoutMs` | `number` | `120_000` | Per-URL HTTP/extraction timeout in milliseconds. |
| `deadlineMs` | `number` | `0` | Hard wall-clock cap per URL including transcription (`0` disables). |
| `maxCharacters` | `number` | `Infinity` | Maximum characters passed downstream. |
| `llmMinCharacters` | `number` | `4_000` | Bodies shorter than this skip optional LLM summarization. |
| `llmTemperature` | `number` | `0.2` | Sampling temperature for summarization calls (`0`–`2`). |
| `llmModel` | `string` | `undefined` | Optional model ID used to summarize extracted pages. |
| `llmLength` | `"short" \| "medium" \| "long" \| "xl" \| "xxl"` | `"medium"` | Default summary length preset. |

### `runs` options (optional)

Defaults for leases, in-memory retention, Redis Streams, and crash recovery. Every field can also be overridden at deploy time via its matching `RUNS_*` [environment variable](/configuration/environment-variables).

## Reading active config (`getConfiguration`)

Access the validated, defaulted `Configuration` object anywhere after startup:

```ts [src/inspect-config.ts]
import { getConfiguration } from "@riavzon/ai";

const cfg = getConfiguration();
cfg.logger.info({ dims: cfg.embeddingConfig.dimensions }, "AI subsystem ready");
```

## Explore configuration

::card-group
  :::card
  ---
  icon: i-lucide-terminal
  title: Environment Variables
  to: /configuration/environment-variables
  ---
  Complete table of all 16 runtime environment overrides for runs, leases, streams, extractor caching, generated files, and document caps.
  :::

  :::card
  ---
  icon: i-lucide-hard-drive
  title: Cache & AI Clients
  to: /configuration/cache-and-clients
  ---
  Reuse the configured OpenAI clients (`aiClients()`) and Redis/`MiniCache` helpers (`cacheGet`, `cacheSet`, `cacheGetMany`, `cacheSetMany`) in your own code.
  :::
::
