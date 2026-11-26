---
title: Agents
description: Build reusable, strongly typed AI agents with createAgent() that combine models, tools, MCP servers, conversations, compaction, caching, and durable runs.
navigation:
  icon: i-lucide-bot
seo:
  title: Agents & createAgent() Runtime — Riavzon AI
  description: Create reusable AI agents with createAgent(), configure ModelOptions, stream turns with agent.chat(), buffer turns with agent.complete(), and close MCP cleanly.
---

`createAgent()` is the primary high-level abstraction in `@riavzon/ai`. You define an agent once at startup — its model settings, system instructions, built-in and custom tools, MCP servers, conversation persistence, compaction, semantic cache, and optional run-system integration — and execute turns against it across requests.

Static setup happens inside `createAgent()`: built-in tool specs resolve, MCP servers connect, duplicate tool names fail fast, and inconsistent configuration (such as enabling `runs` or `compaction` without `conversation: { persist: true }`) throws immediately at construction rather than on the first user request.

## Create an agent

Pass an `AgentConfig<TMeta>` object to `createAgent<TMeta>()`. The optional `TMeta` generic types request-scoped metadata passed into your custom tool factories.

```ts [src/agents/support.ts]
import { createAgent } from "@riavzon/ai";

interface SupportMeta {
  tenantId: string;
  plan: "free" | "pro" | "enterprise";
}

export async function createSupportAgent() {
  return await createAgent<SupportMeta>({
    model: {
      model: "gpt-4o-mini",
      temperature: 0.3,
      maxTokens: 4096,
      thinkingEffort: "medium",
      tools: {
        temperature: 0.1,
        maxTokens: 2048,
        maxRounds: 6,
        maxCalls: 15,
      },
      body: {
        parallel_tool_calls: true,
      },
      request: {
        timeout: 60_000,
        maxRetries: 2,
      },
    },
    systemInstructions:
      "You are a technical support assistant. Cite facts from tools and keep replies clear.",
    tools: {
      common: ["calculator", "get_current_datetime", "search_db"],
    },
    conversation: {
      persist: true,
    },
    meta: {
      tenantId: "default",
      plan: "free",
    },
  });
}
```

## `AgentConfig` reference

Configure only the subsystems your agent needs. Omitting `conversation` creates a stateless agent that accepts caller-supplied `history` on each turn.

::field-group
  :::field{name="model" type="ModelOptions" required}
  Provider model ID (`model`), answer sampling (`temperature` default `0.4`, `maxTokens` default `8192`), tool-round sampling (`tools.temperature` default `0.1`, `tools.maxTokens` default `4096`, `tools.maxRounds` default `5`, `tools.maxCalls` default `20`), reasoning budget (`thinkingEffort`: `"low" | "medium" | "high" | "max"`, forwarded strictly as OpenAI `reasoning_effort`), extra OpenAI body fields (`body`: `ModelBodyOptions`, such as `top_p`, `seed`, `response_format`, `parallel_tool_calls`, `verbosity`, `service_tier`), and transport options (`request`).
  :::

  :::field{name="systemInstructions" type="string" required}
  System prompt prepended to every turn ahead of conversation history.
  :::

  :::field{name="tools" type="ToolOptions<TMeta>"}
  Combines built-in tools (`common`), custom per-request `ToolSpec<TMeta>[]` definitions (`specs`), and MCP server connections (`mcp`).
  :::

  :::field{name="conversation" type="ConversationOptions"}
  Enables persisted threads in the `conversations` and `messages` tables (`persist`, default `true` when the object is provided). Omit to keep the agent stateless.
  :::

  :::field{name="runs" type="RunOptions"}
  Routes every turn through the durable run system (`runs` table, lease heartbeats, Redis event log, and optional in-process replay registry). Requires `conversation: { persist: true }`.
  :::

  :::field{name="compaction" type="CompactionOptions"}
  Summarizes older messages into a rolling `compacted_summary` once estimated history tokens exceed `tokenThreshold`. Requires `conversation`.
  :::

  :::field{name="semanticCache" type="SemanticCacheOptions"}
  Checks recent stored exchanges by cosine similarity before calling the model.
  :::

  :::field{name="attachments" type="AttachmentOptions"}
  Overrides file count, byte size, MIME type, and PDF page limits applied when `input.files` are passed on a turn.
  :::

  :::field{name="embedding" type="EmbeddingOptions"}
  Reserved per-agent embedding override type (`retrievalModel`, `matchingModel`, `dimensions`). Currently, agent turns use the global `embeddingConfig` supplied to `configuration()`.
  :::

  :::field{name="meta" type="TMeta"}
  Default host-defined metadata merged with per-turn `input.meta` before calling each tool's `make(ctx)` factory.
  :::

  :::field{name="trace" type="readonly TraceExtension<Record<string, unknown>>[]"}
  Custom trace extensions that observe every `AgentEvent` and merge extra fields into `ChatTurnResult.trace`.
  :::
::

## Run turns: `chat()` vs. `complete()`

Every `Agent<TMeta>` exposes two execution methods plus `close()` and `readonly config`.

::tabs
  :::tabs-item{label="agent.chat() (Streaming)" icon="i-lucide-radio"}
  `agent.chat(input)` returns `{ frames, done }`:

  - **`frames`**: an `AsyncIterable<SseFrame>` yielding live events (`init`, `chunk`, `reasoning`, `tool_start`, `tool_end`, `error`, `done`).
  - **`done`**: a `Promise<ChatTurnResult>` that resolves when the turn finishes, aborts, or fails.

  ```ts [src/stream-turn.ts]
  const stream = await agent.chat({
    message: "Summarize our latest Q4 billing report.",
    userId: "user_123",
    conversationId: 7,
    meta: { tenantId: "acme", plan: "enterprise" },
    user: {
      locale: "en-US",
      timezone: "America/New_York",
      currentDate: "2026-03-15",
    },
  });

  for await (const event of stream.frames) {
    if (event.type === "chunk") {
      process.stdout.write(String(event.text));
    }
  }

  const result = await stream.done;
  console.log("\nTools used:", result.toolsUsed);
  ```

  ::warning
  When `runs` is **not** configured, the tool loop starts lazily when the first frame is pulled from `stream.frames`. If you never iterate `stream.frames`, `stream.done` will never resolve. Use `agent.complete()` whenever you only need the final result.
  ::
  :::

  :::tabs-item{label="agent.complete() (Buffered)" icon="i-lucide-check-circle"}
  `agent.complete(input)` drains the turn internally and resolves directly with `ChatTurnResult`:

  ```ts [src/buffered-turn.ts]
  const result = await agent.complete({
    message: "What is 15% of 2,400?",
    userId: "user_123",
    model: {
      temperature: 0,
    },
  });

  console.log(result.text);
  console.log(result.conversationId);
  console.log(result.cached);
  console.log(result.trace);
  ```
  :::
::

### Per-turn overrides (`ChatInput`)

Every call to `agent.chat()` or `agent.complete()` accepts these request-scoped fields:

- **`message`** *(required)*: the user prompt for this turn.
- **`userId`**: required whenever `conversation` is configured so rows stay scoped to the owning user.
- **`conversationId`**: resumes an existing thread; omit to create a new conversation titled from `message`.
- **`history`**: manual `HistoryMessage[]` list used only for stateless agents (ignored when `conversation` is configured).
- **`files`**: attached `File[]` objects parsed via `parseFiles()` and prepended as Markdown.
- **`runId`**: explicit run identifier when `runs` is enabled (generated via `crypto.randomUUID()` when omitted).
- **`signal`**: `AbortSignal` merged with the run's internal stop signal.
- **`model`**: per-turn overrides for `model`, `temperature`, `maxTokens`, `thinkingEffort`, `tools`, or `body` (`request` remains agent-wide).
- **`meta`**: partial metadata merged over `AgentConfig.meta` for this turn's tool factories.
- **`user`**: optional context (`locale`, `timezone`, `currentDate`, `geo`, `other`) appended to the system prompt for this turn.
- **`json`**: requests raw JSON mode or schema-validated structured output.

### Transport-level request options (`model.request`)

Use `model.request` (`ModelRequestOptions`) to attach OpenAI SDK transport options — such as custom headers, timeouts, retries, or query parameters — to every completion call made by the agent. It is bound once on the agent's client at construction (`createAgent()`) and applies uniformly across all turns and compaction calls (it cannot be overridden per turn via `input.model`):

```ts [src/agents/request-options.ts]
import { createAgent } from "@riavzon/ai";

export const gatewayAgent = await createAgent({
  model: {
    model: "gpt-4o-mini",
    request: {
      timeout: 45_000,
      maxRetries: 3,
      headers: {
        "X-App-Name": "support-portal",
        "X-Region": "eu-central-1",
      },
    },
  },
  systemInstructions: "You are a concise support assistant.",
});
```

### Streaming vs. validated JSON error handling

Error handling intentionally differs between streaming turns and validated JSON turns:

- **Streaming turns** (`agent.chat()` without `json.validate`, or `agent.complete()`): unexpected failures are caught inside the turn, emitted as a terminal `{ type: "error", message }` frame, recorded on the `runs` row when `runs` is enabled, and surfaced on `ChatTurnResult.error` so SSE responses terminate cleanly.
- **Validated JSON turns** (`json: { validate: true, schema }`): if parsing, schema validation, or the provider fails after all repair retries, the turn marks any active run `aborted` or `failed` and **rethrows** so callers never receive unvalidated data typed as `z.output<S>`.

## Release resources with `agent.close()`

When an agent configures `tools.mcp`, `createAgent()` opens live MCP client connections. Always call `await agent.close()` during graceful shutdown to disconnect every MCP server cleanly. An agent cannot be used after `close()` completes.

```ts [src/shutdown.ts]
const agent = await createSupportAgent();

process.on("SIGTERM", async () => {
  await agent.close();
  process.exit(0);
});
```

## Escape the abstraction (`agent.config`)

Every agent exposes `readonly config: AgentConfig<TMeta>` so you can inspect the resolved configuration or drop down to `executeToolLoop()`, `buildToolRegistry()`, and `runAgentStream()` directly whenever a route needs custom orchestration.

## Explore agent capabilities

::card-group
  :::card
  ---
  icon: i-lucide-messages-square
  title: Conversations & Compaction
  to: /agents/conversations-and-compaction
  ---
  Persist multi-turn threads, replay tool traces across turns, and keep long histories inside token budgets.
  :::

  :::card
  ---
  icon: i-lucide-braces
  title: Structured Output
  to: /agents/structured-output
  ---
  Request raw JSON mode or Zod-validated objects with automatic repair retries.
  :::

  :::card
  ---
  icon: i-lucide-paperclip
  title: Attachments & Semantic Cache
  to: /agents/attachments-and-caching
  ---
  Parse uploaded PDFs, spreadsheets, and text files, and serve near-identical repeated questions from the semantic cache.
  :::

  :::card
  ---
  icon: i-lucide-shield-check
  title: Durable Agent Runs
  to: /agents/agent-runs
  ---
  Back every agent turn with a database lease, Redis event stream, and client reattach support.
  :::

  :::card
  ---
  icon: i-lucide-layers
  title: Production Agent & Streaming Recipes
  to: /agents/production-agent-and-streaming
  ---
  End-to-end kitchen-sink agent plus complete CLI, Web/Node HTTP server, and frontend SSE client consumers.
  :::
::
