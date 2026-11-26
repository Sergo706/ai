---
title: Tools
description: Give agents capabilities from built-in tools, custom per-request ToolSpec factories, and remote Model Context Protocol (MCP) servers, or drive executeToolLoop() directly.
navigation:
  icon: i-lucide-wrench
seo:
  title: Tools, Registry & Tool Execution — Riavzon AI
  description: "Overview of @riavzon/ai tools: built-in common tools, ToolSpec factories, buildToolRegistry(), MCP servers, caching, concurrency limits, and executeToolLoop()."
---

Tools in `@riavzon/ai` follow one uniform contract — `ToolSpec<TMeta>` — regardless of whether a tool comes from the built-in catalog, your own application code, or a remote MCP server.

Instead of global singleton handlers that leak user state across requests, each `ToolSpec` supplies a `make(ctx)` factory. On every turn, `buildToolRegistry()` instantiates fresh handlers scoped to `{ userId, conversationId, meta }` and wraps them in a deterministic middleware chain: **call cap (`limitTool`) → response cache (`withToolCache`) → usage tracking (`trackTool`)**.

## Three tool sources

Combine any mix of built-in tools, custom specs, and MCP servers inside `createAgent({ tools })` or assemble them manually with `buildToolRegistry()`.

::card-group
:::card
---

icon: i-lucide-box
title: Built-in Tools
to: /tools/built-in-tools
---

Eight ready-to-use tools covering math, currency conversion, current time, RAG search, document paging, web extraction, PDFs, and styled spreadsheets.
:::

:::card
---

icon: i-lucide-code
title: Custom ToolSpec & Registry
to: /tools/custom-tools
---

Define per-request typed tools with `ToolSpec`, per-tool caching, concurrency buckets, call caps, and SSE disclosure policies.
:::

:::card
---

icon: i-lucide-plug
title: MCP Tools
to: /tools/mcp-tools
---

Connect to Streamable HTTP Model Context Protocol servers with bearer/OAuth/header auth, namespacing, exclusions, and shared tool policies.
:::

:::card
---

icon: i-lucide-repeat
title: Low-Level executeToolLoop
to: /tools/tool-loop
---

Run the streaming or non-streaming tool loop directly in your own AI client without `createAgent()`.
:::

:::card
---

icon: i-lucide-chef-hat
title: Tool Recipes & Standalone Client
to: /tools/tool-recipes
---

Full custom tool recipe (Zod, caching, Markdown serialization, sub-progress) plus a standalone `executeToolLoop()` + MCP client.
:::
::

## How the tool middleware chain works

When `buildToolRegistry(ctx, specs)` builds handlers for a turn, wrappers apply in a strict order so every policy behaves predictably:

1. **Base handler (`spec.make(ctx)`)**: captures the current `userId`, `conversationId`, and host `meta`.
2. **Call cap (`limitTool`)**: if `spec.maxCalls` is set, rejects calls past the cap with a `TOOL_LIMIT_REACHED` envelope instructing the model to synthesize its final answer from existing results.
3. **Cache (`withToolCache`)**: if `spec.cache` is set, computes a canonicalized SHA-256 hash of `(toolName, scopeKey, normalizeArgs(args))` and reads/writes `toolcache:<toolName>:<hash>`. Error payloads are never cached.
4. **Usage tracker (`trackTool`)**: records the tool name in `registry.usedTools` so `ChatTurnResult.toolsUsed` and semantic-cache `poisonTools` always see every tool the model invoked — even on cache hits.

::note
Because `withToolCache` wraps `limitTool`, repeated cached calls still stay bounded and failed calls (`toolError(...)`, `{ ok: false }`, or `{ error: ... }`) never pollute the cache.
::

## Combine all three sources in `createAgent()`

```ts [src/tools-combined.ts]
import { createAgent, searchDb, type ToolSpec } from "@riavzon/ai";

interface AppMeta {
  orgId: string;
}

const getInvoice: ToolSpec<AppMeta> = {
  name: "get_invoice",
  definitions: {
    type: "function",
    function: {
      name: "get_invoice",
      description: "Fetch an invoice by ID for the current organization.",
      parameters: {
        type: "object",
        properties: { invoiceId: { type: "string" } },
        required: ["invoiceId"],
      },
    },
  },
  cache: { ttl: 600, scoped: true },
  maxCalls: 3,
  make:
    (ctx) =>
    async ({ invoiceId }) => ({
      invoiceId: String(invoiceId),
      orgId: ctx.meta?.orgId,
      amountUsd: 240,
    }),
};

export const agent = await createAgent<AppMeta>({
  model: {
    model: "gpt-4o-mini",
    tools: { maxRounds: 6, maxCalls: 15 },
  },
  systemInstructions:
    "Help users inspect invoices, documents, and external tools.",
  tools: {
    common: [
      "calculator",
      { name: "search_db", make: (ctx) => searchDb(ctx.userId) },
      { name: "get_document", maxCalls: 4 },
    ],
    specs: [getInvoice],
    mcp: [
      {
        namespace: "github",
        url: "https://mcp.example.com/github",
        auth: { type: "bearer", token: process.env.MCP_TOKEN! },
        policy: { concurrency: 2, cache: { ttl: 300 } },
      },
    ],
  },
});
```

::warning
Every tool name across `tools.common`, `tools.specs`, and `tools.mcp` must be unique. `createAgent()` validates for collisions at construction time and throws if two sources claim the same tool name.
::
