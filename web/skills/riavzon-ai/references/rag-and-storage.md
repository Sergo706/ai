# RAG, Ingestion & Storage (`@riavzon/ai`)

## Dialect-Portable Vector Storage

`@riavzon/ai` uses Kysely across both SQLite (`better-sqlite3` + `sqlite-vec`) and PostgreSQL (`pg` + `pgvector`).

- `toVec(vector)` writes a pgvector literal on PostgreSQL and a `Float32Array` buffer on SQLite.
- `fromVec(raw)` decodes both formats back into `number[]`.
- `getDistance(column, vector)` builds portable cosine distance expressions (`<=>` on Postgres, `vec_distance_cosine` on SQLite).

Tables managed automatically during `configuration()`:
- `conversations` — conversation threads, rolling compaction summaries, metadata
- `messages` — user/assistant turns, traces, embeddings for semantic cache
- `documents` — deduplicated documents (`content_hash` SHA-256, `user_id`, metadata)
- `document_chunks` — token-sized chunks + vector embeddings
- `runs` — durable run state, leases, heartbeats, checkpoints

## Chunking & Embeddings

```ts
import { chunkByTokens, countTokens, embedText, embedTexts, prepareScrape } from "@riavzon/ai";

// Heuristic token counting by default; optionally pass a @huggingface/transformers PreTrainedTokenizer
const tokens = countTokens(markdownText);
const chunks: string[] = chunkByTokens(markdownText, 512, 64);

// Embed one or many strings using configuration().embeddingConfig
const queryVec = await embedText("How does lease recovery work?");
const chunkVecs = await embedTexts(chunks);

// Chunk + embed scraped markdown together with caller-defined metadata
const prepared = await prepareScrape(
  "Run System Guide",
  markdownText,
  { url: "https://example.com/guide" },
  { maxTokens: 512, overlapTokens: 64 },
);
```

## Ingest Files with Deduplication (`saveUploadedScrappedFile`)

`saveUploadedScrappedFile()` hashes content with SHA-256 to avoid duplicate ingestion per tenant, chunks text, generates embeddings, and inserts into `documents` + `document_chunks`.

```ts
import { saveUploadedScrappedFile, readPdfToMarkdown } from "@riavzon/ai";

const pdfMarkdown = await readPdfToMarkdown(pdfBuffer);
const saved = await saveUploadedScrappedFile(
  [{ name: "handbook.md", data: pdfMarkdown }],
  userId,
);
```

## Tenant-Scoped Vector Search & Full Document Reads

```ts
import { embedText, fetchRelevantChunks, searchDbDocs, readToolDocument } from "@riavzon/ai";

// 1. Vector similarity retrieval scoped to a tenant
const queryVector = await embedText("refund policy");
const chunks = await fetchRelevantChunks(queryVector, 8, 0, 0.35, userId);

// 2. High-level search helper used by built-in search_db
const results = await searchDbDocs({ query: "refund policy", limit: 8 }, userId);

// 3. Budget-capped full document read (respects DOCUMENT_* env caps)
const doc = await readToolDocument(userId, { documentId: chunks[0].documentId });
```

## Adaptive Chunk Filtering (`filterAdaptiveChunks`)

When combining scraped web pages or noisy multi-source chunks, use `filterAdaptiveChunks()` to score chunks against a query embedding, drop low-coverage noise, and reject near-duplicates (with authority bypass so authoritative sources are preserved):

```ts
import { filterAdaptiveChunks, embedText } from "@riavzon/ai";

const queryVector = await embedText(userQuestion);
const existingVectors: number[][] = [];
const filtered = await filterAdaptiveChunks(
  queryVector,
  prepared.chunks,
  existingVectors,
  {
    candidateLimit: 24,
    minCoverage: 0.3,
    duplicateThreshold: 0.9,
    embeddingConcurrency: 4,
  },
);
```

## File Generation & Download Helpers

- **Readers:** `readPdfToMarkdown(buf)`, `readXlsxToMarkdown(buf)`, `readCsvToMarkdown(buf)`
- **Generators:** `createPdf(...)` (`pdf-lib` + `@pdf-lib/fontkit`), `generateStyledSpreadsheet(...)` (`exceljs`)
- **Serving tool-generated files:** Built-in `pdf_creator` and `create_styled_spreadsheet` return a `fileKey`. Serve downloads from your HTTP route with `readGeneratedFile(fileKey)` (TTL controlled by `AGENT_GENERATED_FILE_TTL`).

## Key SQL Models

Use exported models directly when building admin UIs, history sidebars, or custom pipelines:
- Conversations & Messages: `getConversations`, `getMessages`, `loadConversationHistory`, `saveUserMessage`, `saveAssistantMessage`, `checkChatSemanticCache`
- Vector math: `calculateCosineSimilarity(a, b)`
- Schema & text helpers: `llmSchemaParser`, `stripThinking`, `stripCodeFences`, `jsonToMarkdown`, `safeValidateUrl`
