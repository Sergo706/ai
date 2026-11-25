---
title: RAG & Vector Search
description: Embed, chunk, ingest, deduplicate, and search knowledge documents across PostgreSQL (pgvector) and SQLite (sqlite-vec) using @riavzon/ai.
navigation:
  icon: i-lucide-search
seo:
  title: RAG & Vector Search — Riavzon AI
  description: Learn how @riavzon/ai handles asymmetric embeddings, token-aware chunking, deduplicated document ingestion, semantic search, and adaptive chunk filtering.
---

`@riavzon/ai` ships a complete Retrieval-Augmented Generation (RAG) stack that works identically against PostgreSQL (`pgvector`) and SQLite (`sqlite-vec`). Every stage — from raw Markdown ingestion to hybrid retrieval and adaptive deduplication — is exported as a standalone building block so you can plug it into `createAgent()` via `search_db` and `get_document` or call it directly inside your own AI pipelines.

## RAG data flow

```text [Pipeline Overview]
Raw Markdown / Files
  │
  ├─► prepareScrape()               Token-aware chunking + retrieval embeddings
  │     └─► saveUploadedScrappedFile()  SHA-256 content-hash dedupe + batch SQL insert
  │
  └─► User Query
        └─► generateMatchingEmbedding()  Asymmetric query vector
              ├─► fetchRelevantChunks()  Top-K cosine distance query (SQL)
              ├─► searchDbDocs()         High-level Zod-validated search wrapper
              └─► filterAdaptiveChunks() Coverage + near-duplicate filtering for live scrapes
```

## Two-model asymmetric embedding support

Many modern embedding families (such as Nomic, BGE, Cohere, and Voyage) distinguish between document embeddings and query embeddings. Configure `embeddingConfig` once in `configuration()`:

```ts [src/ai-config.ts]
import { configuration } from "@riavzon/ai";

await configuration({
  // ...database & aiClient
  embeddingConfig: {
    retrievalModel: "text-embedding-3-small", // Used when embedding document chunks
    matchingModel: "text-embedding-3-small",  // Used when embedding queries & dedupe vectors
    dimensions: 1536,                         // Verified at runtime on every call
  },
});
```

Both `generateEmbedding()` and `generateMatchingEmbedding()` validate that the provider's returned vector length equals `embeddingConfig.dimensions` and throw immediately on mismatch, preventing silent database corruption.

::note
If your database already contains embeddings and you change `embeddingConfig.dimensions`, you must recreate the vector columns (`document_chunks.embedding`, `messages.embedding`) and re-embed existing records.
::

## Connecting RAG to an agent

Enable the built-in `search_db` and `get_document` tools on any `createAgent()` instance so the model can search ingested documents and read complete files by `documentId`:

```ts [src/rag-agent.ts]
import { createAgent, searchDb } from "@riavzon/ai";

export const docsAgent = await createAgent({
  model: { model: "gpt-4o-mini" },
  systemInstructions:
    "Answer questions using search_db. Call get_document when you need full context.",
  tools: {
    common: [
      // Scope vector search per user (omit override for a shared knowledge base)
      {
        name: "search_db",
        cache: { ttl: 3600, scoped: true },
        make: (ctx) => searchDb(ctx.userId),
      },
      "get_document",
    ],
  },
});
```

`get_document` automatically scopes reads to `ctx.userId`. Override `search_db` with `make: (ctx) => searchDb(ctx.userId)` and `cache: { ttl: 3600, scoped: true }` whenever you want strict per-user tenant isolation.

## Explore the RAG modules

::card-group
  :::card
  ---
  icon: i-lucide-scissors
  title: Chunking & Embeddings
  to: /rag/chunking-and-embeddings
  ---
  Generate vectors with `generateEmbedding()` / `generateMatchingEmbedding()`, slice text with `chunkByTokens()`, and format scrapes via `prepareScrape()`.
  :::

  :::card
  ---
  icon: i-lucide-database-zap
  title: Ingestion & Vector Search
  to: /rag/ingestion-and-search
  ---
  Persist files with `saveUploadedScrappedFile()` and retrieve matching chunks with `fetchRelevantChunks()` and `searchDbDocs()`.
  :::

  :::card
  ---
  icon: i-lucide-filter
  title: Adaptive Chunk Filtering
  to: /rag/adaptive-filtering
  ---
  Score freshly scraped chunks against a query and drop near-duplicates before inserting using `filterAdaptiveChunks()`.
  :::
::
