---
name: riavzon-ai
description: Build AI agents, custom and MCP tools, hybrid RAG pipelines, and SSE streaming servers with @riavzon/ai. Use when configuring @riavzon/ai, calling configuration() or createAgent(), adding built-in/custom/MCP tools, implementing document ingestion and vector retrieval, or streaming turns over HTTP/CLI.
---

# `@riavzon/ai` Core Runtime

`@riavzon/ai` is an embeddable, zero-magic TypeScript agent runtime. It owns the agent loop, tool execution protocol, dialect-portable storage/RAG, and durable run lifecycle — while leaving HTTP routing, database ownership, and OpenAI wire payloads in your hands.

## Core Rules

1. **Single entry point only:** Always import every function, class, constant, schema, and type directly from `"@riavzon/ai"`. Subpath imports such as `"@riavzon/ai/agents"` do not exist.
2. **Initialize once at startup:** `await configuration(...)` must run before calling `createAgent()`, database models, cache helpers, or `startRuns()`. Importing the package before `configuration()` is safe (lazy initialization).
3. **Lazy optional peers:** Heavy dependencies are loaded dynamically on first feature use — install only what your project uses.
4. **Always clean up MCP connections:** Call `await agent.close()` (or `await mcp.close()` for standalone toolsets) on server shutdown.

## Optional Peer Dependency Matrix

| Feature                                                        | Packages to Install            |
| -------------------------------------------------------------- | ------------------------------ |
| Core runtime (always required)                                 | `@riavzon/ai`, `openai`        |
| SQLite + vector search                                         | `better-sqlite3`, `sqlite-vec` |
| PostgreSQL + vector search                                     | `pg`, `@types/pg`              |
| Redis cache / cross-replica runs / file tools                  | `ioredis`                      |
| Built-in `calculator`                                          | `mathjs`                       |
| Built-in `currencies_convertor`                                | `easy-currencies`              |
| Built-in `create_styled_spreadsheet` / XLSX & CSV readers      | `exceljs`                      |
| Built-in `pdf_creator` / `createPdf()`                         | `pdf-lib`, `@pdf-lib/fontkit`  |
| Built-in `extractor` / `extractWithSummarize()` / `extractManyWithSummarize()` / `summarizeWithLlm()` / `withLlmSummary()` | `@steipete/summarize-core` |
| Built-in `get_current_datetime` / `search_db` / `get_document` | Core + DB peer only            |
| MCP client (`tools.mcp` / `createMcpToolset()`)                | `@modelcontextprotocol/client` |
| Exact tokenizer chunking (`PreTrainedTokenizer`)               | `@huggingface/transformers`    |

## 1. Runtime Initialization (`configuration`)

Only `db`, `openAiConfig`, and `embeddingConfig` are required. Pass a SQLite file path string (`"./data/app.db"`) for local single-node apps or a `pg.Pool` instance for PostgreSQL + `pgvector`.

```ts
import OpenAI from "openai";
import { configuration } from "@riavzon/ai";

await configuration({
  db: "./data/app.db", // or new Pool({ connectionString: process.env.DATABASE_URL })
  openAiConfig: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  embeddingConfig: {
    dimensions: 1536,
    matchingModel: "text-embedding-3-small",
    retrievalModel: "text-embedding-3-small",
    // client: new OpenAI({ ... }) // optional separate provider/endpoint for embeddings
  },
  redis: "memory", // default "memory" (MiniCache); pass an ioredis instance for multi-replica
});
```

- `openAiConfig` accepts any OpenAI-compatible `OpenAI` client (OpenAI, OpenRouter, LiteLLM, vLLM, or Ollama). Pass `embeddingConfig.client` to route embeddings to a different provider or local model.
- Migrations run automatically during `configuration()`, creating `conversations`, `messages`, `documents`, `document_chunks`, and `runs` (plus `sqlite-vec` virtual tables or `pgvector` HNSW indexes).

## 2. Create and Run Agents (`createAgent`)

`createAgent()` validates configuration eagerly at construction: duplicate tool names throw immediately, and enabling `compaction` or `runs` without `conversation: { persist: true }` throws immediately.

```ts
import { z } from "zod";
import { createAgent, type ToolSpec } from "@riavzon/ai";

const lookupOrder: ToolSpec<{ tenantId: string }> = {
  name: "lookup_order",
  definitions: {
    type: "function",
    function: {
      name: "lookup_order",
      description: "Fetch order status by ID for the signed-in user.",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
      },
    },
  },
  cache: { ttl: 60, scoped: true },
  maxCalls: 5,
  make:
    ({ userId, meta }) =>
    async (args) => {
      const { orderId } = z.object({ orderId: z.string() }).parse(args);
      return { orderId, userId, tenantId: meta?.tenantId, status: "shipped" };
    },
};

export const supportAgent = await createAgent<{ tenantId: string }>({
  model: {
    model: "gpt-4.1-mini",
    temperature: 0.3,
    maxTokens: 4096,
    thinkingEffort: "medium", // forwarded strictly as OpenAI reasoning_effort
    tools: { maxRounds: 6, maxCalls: 20, temperature: 0.1, maxTokens: 4096 },
    request: { timeout: 60_000, maxRetries: 2 },
  },
  systemInstructions:
    "You are a concise support assistant. Use tools before guessing.",
  tools: {
    common: [
      "calculator",
      "get_current_datetime",
      "search_db",
      { name: "get_document", maxCalls: 2 },
    ],
    specs: [lookupOrder],
  },
  conversation: { persist: true },
  compaction: {
    temperature: 0.2,
    maxTokens: 1024,
    tokenThreshold: 16_000,
    keepRecentMessages: 8,
  },
  attachments: { maxFiles: 3, maxBytes: 10_000_000, maxPdfPages: 5 },
  semanticCache: { similarity: 0.92, windowHours: 24 },
});
```

### Execute Turns (`agent.chat` vs. `agent.complete`)

- **Streaming (`await agent.chat(input)`):** Async method accepting `ChatInput<TMeta>` (`{ message, userId?, conversationId?, runId?, files?, history?, signal?, model?, meta?, user? }`) and resolving to `ChatStream` (`{ frames: AsyncIterable<SseFrame>, done: Promise<ChatTurnResult> }`). Catches runtime errors, emits an `{ type: "error", message }` frame, and resolves `done` with `result.error`.
- **Buffered (`await agent.complete(input)`):** Returns `Promise<ChatTurnResult>` directly.
- **Validated JSON (`json: { validate: true, schema }`):** Uses `llmSchemaParser` with automatic repair retries (default `maxRetries: 2`), populating `result.structured`. Unlike streaming text turns, validation failure marks any active run `failed`/`aborted` and **rethrows**.
- **Stateless mode:** Omit `conversation` (or set `persist: false`) and pass `history: HistoryMessage[]` per turn.
- **Semantic cache behavior:**
  - Bypassed when `files` are attached (`hasFiles`).
  - When `runs` is enabled, a semantic cache hit still creates a real `RunHandle`, publishes `{ type: "chunk", text }` + `{ type: "done" }`, persists the exchange and finished `runs` row, and schedules disposal so clients get instant replies AND a replayable `runId`.

### Choosing the Right SSE Helper

| Use Case                                                                       | Helper                                                                 |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Turn `await agent.chat()` frames into a Web `ReadableStream`                   | `framesToStream(frames, { heartbeatMs, onCancel })`                    |
| Instant canned reply without calling an LLM                                    | `staticReplyStream(conversationId, text)`                              |
| Build a custom chat pipeline without `createAgent()`                           | `runAgentStream(options)`                                              |
| Stream a non-durable workflow or background job                                | `workflowStream({ execute, onError?, heartbeatMs? })`                  |
| Stream a durable, reattachable run (see `riavzon-ai-workflows-and-runs` skill) | `streamFromRun()`, `streamFromStore()`, `workflowStreamWithRegistry()` |

Always pair streams with `setSseHeaders()` (`text/event-stream`, `no-cache`, `X-Accel-Buffering: no`).

## Common Pitfalls & Subtle Behaviors

- **`agent.chat()` is async:** Always `const { frames, done } = await agent.chat(...)` and iterate `frames` (never `turn.stream`).
- **`executeToolLoop({ stream: true })` and `emit`:** When `emit` is omitted, the returned `AsyncGenerator` yields all tool-round and synthesis events automatically. When `emit` is provided (for example `emit: (e) => sink.push(e)` with `runAgentStream()`), tool-round events go to `emit` and only fallback synthesis/error events yield from the generator (no duplicates).
- **`init` frame vs. `runId`:** `agent.chat()` emits `{ type: "init", conversationId }` without `runId`. Clients obtain `runId` from caller-minted `input.runId`, `ChatTurnResult.runId`, or `streamFromRun({ runId })`.
- **`AgentConfig.embedding`:** Declared on `AgentConfig`, but `createAgent()` currently reads global `embeddingConfig` from `configuration()`.
- **`runs` toggle:** Providing `runs` on `createAgent()` always registers a `RunHandle` in process memory.
- **Generated file tools (`pdf_creator`, `create_styled_spreadsheet`):** Require Redis (`ioredis`) in `configuration({ redis })` to store download bytes under `fileKey`, served via `readGeneratedFile(fileKey)`.
- **File attachments (`input.files`) are text-only:** Binary files (images, audio, video, `.docx`, raw binaries) are rejected by `parseFiles()`. Supported PDF/CSV/XLSX/`text/*` files are extracted as plain text/Markdown and prepended directly into the `{ role: "user" }` content as `[USER UPLOADED FILES FOR CONTEXT]\n--- START FILE: <name> ---\n...\n--- END FILE ---\n\n[USER MESSAGE]\n<message>` (never sent as multimodal/image parts).
- **MCP binary returns are omitted:** `createMcpToolset()` / `tools.mcp` extracts only `text`, text `resource.text`, `resource_link`, and `structuredContent`. Binary `image`, `audio`, and `resource.blob` blocks are skipped silently and never provided to the model.
- **Hidden prompt injections to know when debugging:** `createAgent()` appends `Information about the user:` lines to `systemInstructions` when `input.user` is set; compaction sends an internal summarizer prompt and injects a second `{ role: "system", content: "[System Note: Earlier conversation summary: ...]" }` message; `executeToolLoop()` appends a trailing synthesis `{ role: "system" }` message only when tool budgets exhaust or no tools run; `limitTool()` returns `TOOL_LIMIT_REACHED` telling the model not to call the tool again; `llmSchemaParser()` appends a correction `{ role: "user" }` message on validation retries.
- **Tenant scoping in RAG:** Pass `userId` into chat inputs, tool contexts, and retrieval helpers (`searchDbDocs`, `fetchRelevantChunks`, `readToolDocument`) so vector searches and document reads stay scoped to one owner.

## Deep References (Load On Demand)

- **[Tools, Built-ins, Caching & MCP](references/tools-and-mcp.md)** — All 8 built-in tools, `ToolSpec` factories, `ToolStreamPolicy`, `withToolCache`, `toolError()`, `limitTool`/`trackTool`, `createMcpToolset`, and standalone `executeToolLoop`.
- **[RAG, Ingestion & Storage](references/rag-and-storage.md)** — Chunking, `prepareScrape`, embeddings, `saveUploadedScrappedFile`, `fetchRelevantChunks`, `filterAdaptiveChunks`, `readToolDocument`, file helpers, and Kysely models.
- **[Streaming, HTTP Adapters & Tracing](references/streaming-and-http.md)** — Web Standard & Node.js HTTP SSE servers, typed frontend SSE consumer, `SseEvent` frames, `TraceCollector`, `TraceExtension`, and `createRequestAbort`.
- For multi-stage `AgenticWorkflowLoop` and the durable `Run System` (leases, checkpoints, crash recovery, cross-replica SSE reattachment), load the companion **`riavzon-ai-workflows-and-runs`** skill.
