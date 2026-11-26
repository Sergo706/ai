---
title: Database & Models
description: Type-safe Kysely schema, automatic migrations, dialect-portable helpers (PostgreSQL + SQLite), and low-level data models for conversations, RAG documents, and runs.
navigation:
  icon: i-lucide-database
seo:
  title: Database & Models — Riavzon AI
  description: Explore @riavzon/ai's Kysely Database schema (documents, document_chunks, conversations, messages, runs), dialect helpers, and standalone model functions.
---

`@riavzon/ai` manages persistence through [Kysely](https://kysely.dev) with a single strongly typed `Database` schema that runs identically on **PostgreSQL** (`pgvector`) and **SQLite** (`sqlite-vec`). When you call `await configuration(...)`, the package connects to your database, configures SQLite pragmas (`WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, `sqlite-vec`) when given a file path, and automatically runs its built-in migrations (`001_init`, tracked in `@riavzon/ai_migrations`).

## Schema overview

The `Database` interface exports five tables covering RAG storage, chat threads, and durable runs:

| Table             | Purpose                                                                        | Key columns                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documents`       | Ingested knowledge documents.                                                  | `id`, `user_id`, `title`, `raw_content`, `content_hash`, `created_at`                                                                                                                                               |
| `document_chunks` | Token-bounded embedded chunks pointing to `documents.id`.                      | `id`, `document_id`, `chunk_index`, `chunk_text`, `embedding`, `created_at`                                                                                                                                         |
| `conversations`   | Chat threads plus rolling compaction watermarks.                               | `id`, `user_id`, `title`, `compacted_summary`, `compacted_through_message_id`, `created_at`, `updated_at`                                                                                                           |
| `messages`        | Individual `"user"` and `"assistant"` turns with optional traces & embeddings. | `id`, `conversation_id`, `role`, `content`, `trace`, `embedding`, `tools_used`, `created_at`                                                                                                                        |
| `runs`            | Durable run state, SQL leases, checkpoints, and partial outputs.               | `id`, `kind`, `status`, `conversation_id`, `message_id`, `query`, `user_id`, `input`, `partial`, `checkpoint`, `stop_reason`, `error`, `owner`, `claimed_at`, `attempts`, `started_at`, `updated_at`, `finished_at` |

### Querying with your own typed `Kysely<Database>` instance

Because `@riavzon/ai` exports the full `Database` interface (plus every table type `DocumentsTable`, `DocumentChunksTable`, `ConversationsTable`, `MessagesTable`, and `RunsTable`), you can pass the same `pg.Pool` or SQLite handle to your own `Kysely<Database>` instance for custom application queries:

```ts [src/custom-query.ts]
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "@riavzon/ai";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

export async function countUserDocuments(userId: string): Promise<number> {
  const row = await db
    .selectFrom("documents")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("user_id", "=", userId)
    .executeTakeFirstOrThrow();

  return Number(row.count);
}
```

### Extending `RunKindRegistry`

The `runs.kind` column is typed as `RunKind = keyof RunKindRegistry` (`"chat" | "workflow"` by default). Augment `RunKindRegistry` if you add custom run kinds with dedicated resumer strategies:

```ts [src/types/runs.d.ts]
declare module "@riavzon/ai" {
  interface RunKindRegistry {
    ingestion: true;
  }
}

export {};
```

## Dialect-portable helpers

PostgreSQL (`pgvector` + `jsonb`) and SQLite (`sqlite-vec` float32 blobs + JSON text) encode vectors, JSON columns, and cosine distances differently. Use these exported helpers in custom Kysely queries so your code stays 100% portable across both dialects:

```ts [src/dialect-helpers.ts]
import { sql } from "kysely";
import {
  fromJson,
  getDistance,
  timestamp,
  toJson,
  toVec,
  type MessageTrace,
} from "@riavzon/ai";

// 1. JSON serialization / deserialization (safe on both jsonb and TEXT columns)
const serialized: string | null = toJson({ tags: ["billing"] });
const parsed = fromJson<MessageTrace>(rawTraceColumn);

// 2. Vector encoding (pgvector string literal on Postgres, Float32Array blob on SQLite)
const encodedVec = toVec(embeddingVector);

// 3. Cosine distance SQL fragment (`embedding <=> $vec::vector` vs `vec_distance_cosine(...)`)
const distance = getDistance(queryVector);
const rows = await db
  .selectFrom("document_chunks")
  .select(["id", "chunk_text", sql<number>`1 - (${distance})`.as("similarity")])
  .orderBy(distance, "asc")
  .limit(5)
  .execute();

// 4. ISO 8601 timestamps accepted by both dialects
const nowIso = timestamp();
const oneHourAgoIso = timestamp(-60 * 60 * 1000);
```

## Automatic migrations

`configuration()` runs Kysely's `migrateToLatest()` automatically on startup and records applied versions in `@riavzon/ai_migrations` so subsequent boots are fast no-ops. On PostgreSQL, the initial migration (`001_init`) enables `CREATE EXTENSION IF NOT EXISTS vector`, creates vector columns sized to `embeddingConfig.dimensions`, and builds HNSW cosine indexes (`vector_cosine_ops`, `m = 16`, `ef_construction = 64`) on `document_chunks.embedding` and `messages.embedding`. Across both dialects, `001_init` also creates four B-tree indexes (`document_chunks_document_id_chunk_index_idx`, `runs_conversation_idx`, `runs_status_idx`, and `runs_lease_idx`).

::warning
Because `001_init` sizes PostgreSQL vector columns from `embeddingConfig.dimensions` on first boot, set the exact vector dimensions of your chosen embedding model before running `configuration()` against a fresh database.
::

## Next steps

::card-group
:::card
---

icon: i-lucide-table
title: Model Reference
to: /database/models
---

Browse every exported data-access function for conversations, messages, semantic cache, RAG documents, runs, leases, and checkpoints.
:::
::
