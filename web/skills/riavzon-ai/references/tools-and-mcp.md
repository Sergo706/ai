# Tools, Built-ins, Caching & MCP (`@riavzon/ai`)

## Built-in Common Tools (`tools.common`)

Enable built-in tools by name or override config in `createAgent({ tools: { common: [...] } })`, or resolve them standalone with `resolveCommonTools(entries)`.

| Tool Name                   | Peer Dependency                          | Cache Backing                 | Notes                                                                                                                             |
| --------------------------- | ---------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `calculator`                | `mathjs`                                 | None                          | Evaluates mathematical expressions safely                                                                                         |
| `currencies_convertor`      | `easy-currencies`                        | `redis` (memory or Redis)     | Live FX conversion                                                                                                                |
| `get_current_datetime`      | None                                     | None                          | Returns current timestamp / timezone info                                                                                         |
| `extractor`                 | `@steipete/summarize-core`               | Memory (`MiniCache`) or Redis | Dual namespaces `ext:lim:` / `ext:full:`, sanitizes Markdown before model handoff; limits configurable via `EXTRACTOR_*` env vars |
| `search_db`                 | DB vector peer                           | None                          | Tenant-scoped vector search over `document_chunks`                                                                                |
| `get_document`              | DB peer                                  | `redis` (scoped)              | Reads stored document text with `DOCUMENT_*` read budgets (`readToolDocument`)                                                    |
| `pdf_creator`               | `pdf-lib`, `@pdf-lib/fontkit`, `ioredis` | Redis required                | Generates PDFs and stores download bytes under `fileKey` (`AGENT_GENERATED_FILE_TTL`)                                             |
| `create_styled_spreadsheet` | `exceljs`, `ioredis`                     | Redis required                | Generates styled `.xlsx` workbooks and stores download bytes under `fileKey`                                                      |

### Overriding Built-in Tools

Pass a `CommonToolEntry<TMeta>` object (`{ name, cache?, maxCalls?, concurrency?, stream?, make? }`) inside `tools.common` to tune defaults or swap the handler:

```ts
tools: {
  common: [
    "calculator",
    { name: "get_document", maxCalls: 2, cache: { ttl: 1800, scoped: true } },
    { name: "extractor", concurrency: 2 },
  ],
}
```

## Authoring Custom `ToolSpec`s

A `ToolSpec<TMeta>` binds an OpenAI `ChatCompletionTool` definition (`definitions`) to a per-turn factory `make(ctx: ToolFactoryContext<TMeta>)` plus declarative caching, concurrency, call caps, and stream policy:

```ts
import { z } from "zod";
import {
  toolError,
  jsonToMarkdown,
  type ToolSpec,
  type ToolHandler,
} from "@riavzon/ai";

// Reusable parameterized factory for standalone or agent handlers
export function createInventoryHandler(deps: {
  tenantId: string;
}): ToolHandler {
  return async (rawArgs, ctx) => {
    const parsed = z.object({ sku: z.string().min(1) }).safeParse(rawArgs);
    if (!parsed.success) {
      return toolError("INVALID_ARGS", parsed.error.message);
    }

    ctx.emit?.({
      type: "agent_progress",
      agent: "inventory",
      state: "running",
    });
    const stock = await fetchStock(deps.tenantId, parsed.data.sku);
    return { sku: parsed.data.sku, stock };
  };
}

export const inventoryTool: ToolSpec<{ tenantId: string }> = {
  name: "check_inventory",
  definitions: {
    type: "function",
    function: {
      name: "check_inventory",
      description: "Return live stock counts for a product SKU.",
      parameters: {
        type: "object",
        properties: { sku: { type: "string" } },
        required: ["sku"],
      },
    },
  },
  maxCalls: 8,
  concurrency: 3,
  cache: {
    ttl: 120,
    scoped: true,
    normalizeArgs: (a) => ({
      sku: String(a.sku ?? "")
        .trim()
        .toUpperCase(),
    }),
  },
  stream: {
    emitArgs: true,
    emitResult: "preview", // "full" | "preview" | "none"
    serializeForModel: (result) => jsonToMarkdown(result),
  },
  make: ({ meta }) =>
    createInventoryHandler({ tenantId: meta?.tenantId ?? "default" }),
};
```

### Error & Policy Helpers

- **`toolError(code, message, details?)`:** Returns a structured JSON string error envelope so the model can recover instead of crashing the turn.
- **`withToolCache(name, handler, ttlSeconds, scope, normalizeArgs?)`:** Wraps standalone `ToolHandler`s with deterministic cache keys.
- **`limitTool(name, maxCalls, handler, counts)` / `trackTool(name, handler, usedTools)`:** Apply call budgets and usage tracking outside `buildToolRegistry()`.
- **`ToolStreamPolicy`:** Controls `emitArgs` (whether `tool_start` includes args), `emitResult` (`"full" | "preview" | "none"` on `tool_end`), `maxCalls` (surfaced as `callTotal`), and `serializeForModel` (converts non-string results before sending to the LLM — `jsonToMarkdown` saves tokens over raw JSON).

## MCP Servers (`tools.mcp` & `createMcpToolset`)

Requires `@modelcontextprotocol/client`. Connects to Streamable HTTP MCP endpoints, converts each MCP tool into an OpenAI function definition + live `ToolSpec`, supports namespacing and exclusion lists, and extracts `text` blocks, text `resource` entries (`resource.text`), `resource_link`, and `structuredContent`. **Binary MCP returns (`image`, `audio`, and `resource.blob` blocks) are omitted and are never provided to the model** (returning only binary blocks with no `structuredContent` yields `""`).

```ts
import { createAgent, createMcpToolset } from "@riavzon/ai";

// Option A: Managed inside createAgent()
const agent = await createAgent({
  model: { model: "gpt-4.1-mini" },
  systemInstructions: "Use MCP tools when helpful.",
  tools: {
    mcp: [
      {
        namespace: "docs",
        url: "https://ai.riavzon.com/mcp",
        auth: { type: "bearer", token: () => process.env.MCP_TOKEN ?? "" },
        exclude: ["admin_tool"],
        policy: { maxCalls: 6, concurrency: 2, cache: { ttl: 300 } },
      },
    ],
  },
});
// On shutdown:
await agent.close();

// Option B: Standalone toolset (takes an array of McpServerConfig)
const mcp = await createMcpToolset([
  { namespace: "docs", url: "https://ai.riavzon.com/mcp" },
]);
try {
  // Pass mcp.specs into buildToolRegistry(ctx, [...])
} finally {
  await mcp.close();
}
```

## Standalone URL Extraction & Summarization

Requires optional peer `@steipete/summarize-core`. Unlike the built-in `extractor()` tool handler (which sanitizes Markdown, caches per URL, and never invokes an LLM), these standalone helpers expose raw extraction and opt-in LLM condensation directly:

- `extractWithSummarize(url, options?)` → `Promise<SummarizeExtraction>` (defaults from `configuration({ extractor })`; rejects on non-HTML payloads, bodies below `minCharacters`, or `deadlineMs` timeouts).
- `extractManyWithSummarize(urls, options?)` → `Promise<SummarizeOutcome[]>` (concurrent via `Promise.all`; isolates failures into `{ url, ok: false, error }`).
- `summarizeWithLlm(extraction, log, options?)` → `Promise<LlmSummary>` (uses `openAiConfig`, `options.model ?? config.extractor.llmModel`, `options.minCharactersToSummarize ?? config.extractor.llmMinCharacters ?? 4_000`, `options.length ?? config.extractor.llmLength ?? "medium"`, and `config.extractor.llmTemperature ?? 0.2`; returns `passthrough: true` without calling the model when shorter than threshold or if the model replies empty; throws on blank content or missing model).
- `withLlmSummary(extraction, log, options?)` → `Promise<SummarizeExtraction & { summary: LlmSummary }>` (replaces `content`/`characters` in place while preserving metadata).

## Standalone Tool Loop (`executeToolLoop`)

Use `executeToolLoop()` directly for zero-DB CLI tools or custom provider pipelines (`buildToolRegistry` takes `(ctx, specs)`). When `emit` is omitted in `stream: true` mode, the returned `AsyncGenerator` yields all tool-round and synthesis events; passing `emit` (as shown below or with `createEventSink().push`) routes tool-round events through `emit` without double-delivering them:

```ts
import OpenAI from "openai";
import {
  buildToolRegistry,
  executeToolLoop,
  resolveCommonTools,
  type AgentEvent,
} from "@riavzon/ai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const registry = buildToolRegistry(
  { userId: "cli_user", meta: { tenantId: "acme" } },
  [...resolveCommonTools(["calculator"]), inventoryTool],
);

const onEvent = (event: AgentEvent) => {
  if (event.type === "chunk") process.stdout.write(event.text);
  if (event.type === "error")
    process.stderr.write(`\n[error] ${event.message}\n`);
};

for await (const event of executeToolLoop({
  client,
  model: "gpt-4.1-mini",
  messages: [
    { role: "system", content: "Be concise." },
    { role: "user", content: "What is 19% of 4820?" },
  ],
  availableTools: Object.values(registry.definitions),
  handlers: registry.handlers,
  toolStreaming: registry.toolStreaming,
  toolConcurrency: registry.toolConcurrency,
  chat: { temperature: 0.3, maxTokens: 2048 },
  tools: { temperature: 0.1, maxTokens: 2048, maxRounds: 5, maxCalls: 15 },
  thinkingEffort: "low",
  stream: true,
  emit: onEvent,
  signal: AbortSignal.timeout(30_000),
})) {
  onEvent(event);
}
```
