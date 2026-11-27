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
:::field{name="systemInstructions" type="string" required}
System prompt prepended to every turn ahead of conversation history.
:::

:::field{name="meta" type="TMeta"}
Default host-defined metadata merged with per-turn `input.meta` before calling each tool's `make(ctx)` factory.
:::

:::field{name="trace" type="readonly TraceExtension<Record<string, unknown>>[]"}
Custom trace extensions that observe every `AgentEvent` and merge extra fields into `ChatTurnResult.trace`.
:::
::

### `model` (`ModelOptions`, required)

Provider model, answer and tool-round sampling, reasoning effort, request body overrides, and SDK transport options.

::collapsible{name="ModelOptions properties"}
:::field-group
::::field{name="model" type="string" required}
Provider model ID, for example `"gpt-4o-mini"`.
::::

    ::::field{name="temperature" type="number"}
    Sampling temperature for the final answer call. Default: `0.4`.
    ::::

    ::::field{name="maxTokens" type="number"}
    Token cap for the final answer call, sent as `max_tokens`. Default: `8192`.
    ::::

    ::::field{name="thinkingEffort" type="'low' | 'medium' | 'high' | 'max'"}
    Reasoning budget, forwarded directly as OpenAI `reasoning_effort`.
    ::::

    ::::field{name="request" type="ModelRequestOptions"}
    Agent-wide OpenAI SDK transport options (`timeout`, `maxRetries`, `headers`, etc.) bound once at construction. Cannot be overridden per turn via `input.model`.
    ::::

:::
::

#### `model.tools`

Separate sampling and execution budgets during tool-decision rounds, independent from the final answer call.

::collapsible{name="model.tools properties"}
:::field-group
::::field{name="temperature" type="number"}
Sampling temperature for tool-decision rounds. Default: `0.1`.
::::

    ::::field{name="maxTokens" type="number"}
    Token cap for tool-decision rounds. Default: `4096`.
    ::::

    ::::field{name="maxRounds" type="number"}
    Maximum tool-enabled rounds per turn. Set to `0` to disable tools completely. Default: `5`.
    ::::

    ::::field{name="maxCalls" type="number"}
    Maximum attempted tool calls across all rounds (not per round). Default: `20`.
    ::::

:::
::

#### `model.body` (`ModelBodyOptions`)

Optional OpenAI chat completion body fields spread into every request made by the agent.

::collapsible{name="ModelBodyOptions properties"}
:::field-group
::::field{name="top_p" type="number | null"}
Nucleus sampling cutoff.
::::

    ::::field{name="presence_penalty" type="number | null"}
    Penalty for tokens that already appear in the text so far.
    ::::

    ::::field{name="frequency_penalty" type="number | null"}
    Penalty proportional to each token's frequency in the text so far.
    ::::

    ::::field{name="stop" type="string | string[] | null"}
    Stop sequences where the provider halts generation.
    ::::

    ::::field{name="seed" type="number | null"}
    Deterministic sampling seed when supported by the provider.
    ::::

    ::::field{name="response_format" type="ChatCompletionCreateParamsBase['response_format']"}
    Response format override. Overwritten with `{ type: "json_object" }` on turns that pass `input.json`.
    ::::

    ::::field{name="parallel_tool_calls" type="boolean"}
    Controls whether the provider may emit multiple tool calls in a single round.
    ::::

    ::::field{name="verbosity" type="ChatCompletionCreateParamsBase['verbosity']"}
    Provider verbosity hint when supported.
    ::::

    ::::field{name="service_tier" type="ChatCompletionCreateParamsBase['service_tier']"}
    Provider service tier preference.
    ::::

:::
::

### `tools` (`ToolOptions<TMeta>`)

Built-in tools, custom per-request `ToolSpec<TMeta>[]` definitions, and remote MCP server connections exposed to the model.

::collapsible{name="ToolOptions properties"}
:::field-group
::::field{name="common" type="CommonTools<TMeta>"}
Built-in tool names (such as `"calculator"` or `"get_current_datetime"`) or per-tool override objects that tune `cache`, `maxCalls`, `concurrency`, `stream`, or `make`.
::::

    ::::field{name="specs" type="readonly ToolSpec<TMeta>[]"}
    Custom per-request tool definitions with their own JSON Schema, cache, call cap, concurrency, and stream policy.
    ::::

    ::::field{name="mcp" type="readonly McpServerConfig[]"}
    Remote MCP server configurations whose tools are exposed under each server's namespace.
    ::::

:::
::

### `conversation` (`ConversationOptions`)

Enables persisted threads in the `conversations` and `messages` tables. Omit to keep the agent stateless.

::collapsible{name="ConversationOptions properties"}
:::field-group
::::field{name="persist" type="boolean"}
Persist user and assistant messages automatically. Default: `true` when `conversation` is provided; omit `conversation` to keep the agent stateless.
::::
:::
::

### `runs` (`RunOptions`)

Routes every turn through the durable run system (`runs` table, lease heartbeats, and Redis event log). Requires `conversation: { persist: true }`.

::collapsible{name="RunOptions properties"}
:::field-group
::::field{name="kind" type="RunKind"}
Run kind written to `runs.kind` for each turn. Default: `"chat"`.
::::

    ::::field{name="name" type="string"}
    Optional agent name stored in `runs.input.name` to distinguish multiple agents sharing one `kind`.
    ::::

    ::::field{name="registry" type="boolean"}
    Declared option in `RunOptions` for in-process replay. Currently, `createAgent()` always registers the run in the in-process registry whenever `runs` is configured.
    ::::

:::
::

### `compaction` (`CompactionOptions`)

Summarizes older messages into a rolling `compacted_summary` once estimated history tokens exceed `tokenThreshold`. Requires `conversation`.

::collapsible{name="CompactionOptions properties"}
:::field-group
::::field{name="temperature" type="number" required}
Sampling temperature for the summarization call.
::::

    ::::field{name="maxTokens" type="number" required}
    Token cap for the summarization call.
    ::::

    ::::field{name="tokenThreshold" type="number" required}
    Estimated token ceiling (summary plus messages above the watermark) above which older messages are summarized.
    ::::

    ::::field{name="keepRecentMessages" type="number" required}
    Number of recent user and assistant messages kept verbatim after the summary.
    ::::

    ::::field{name="reserveTokens" type="number"}
    Extra token headroom reserved for the system prompt, incoming message, tool results, and final answer.
    ::::

    ::::field{name="attempts" type="number"}
    Write attempts when persisting the updated summary watermark; a failed write never fails the turn. Default: `2`.
    ::::

:::
::

### `semanticCache` (`SemanticCacheOptions`)

Checks recent stored exchanges by cosine similarity and reuses a near-identical reply before calling the model.

::collapsible{name="SemanticCacheOptions properties"}
:::field-group
::::field{name="similarity" type="number"}
Minimum cosine similarity required for a cached reply hit. Default: `0.9`.
::::

    ::::field{name="windowHours" type="number"}
    Lookback window in hours when searching earlier exchanges. Default: `24`.
    ::::

    ::::field{name="poisonTools" type="readonly string[]"}
    Tool names whose earlier use disqualifies a stored reply from being reused.
    ::::

    ::::field{name="skipEvaluator" type="(conversationId: number, message: string) => boolean"}
    Optional predicate; return `true` to bypass semantic cache lookup and call the model for the turn.
    ::::

:::
::

### `attachments` (`AttachmentOptions`)

Validation and extraction limits applied when `input.files` are passed on a turn. Only extracted text from supported formats (PDF, CSV, XLSX, and `text/*`) is forwarded into the user prompt; binary files such as images, audio, and video are not supported.

::collapsible{name="AttachmentOptions properties"}
:::field-group
::::field{name="maxFiles" type="number"}
Maximum number of files accepted per turn. Default: `3`.
::::

    ::::field{name="maxBytes" type="number"}
    Maximum size of a single file in bytes. Default: `10485760` (10 MB).
    ::::

    ::::field{name="mimeTypes" type="readonly string[]"}
    Extra accepted MIME types on top of any `text/*` type. Default: `application/pdf`, `text/csv`, and `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
    ::::

    ::::field{name="maxPdfPages" type="number"}
    Maximum number of PDF pages extracted before text is truncated. Default: `5`.
    ::::

:::
::

### `embedding` (`EmbeddingOptions`)

Reserved per-agent embedding override shape preserved on `agent.config`. Currently, agent turns use the global `embeddingConfig` supplied to `configuration()`.

::collapsible{name="EmbeddingOptions properties"}
:::field-group
::::field{name="retrievalModel" type="string"}
Embedding model ID for document chunks.
::::

    ::::field{name="matchingModel" type="string"}
    Embedding model ID for semantic message matching.
    ::::

    ::::field{name="dimensions" type="number"}
    Vector dimension count.
    ::::

:::
::

## Run turns: `chat()` vs. `complete()`

Every `Agent<TMeta>` exposes two execution methods plus `close()` and `readonly config`.

::tabs
:::tabs-item{icon="i-lucide-radio" label="agent.chat() (Streaming)"}
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

    ::::warning
    When `runs` is **not** configured, the tool loop starts lazily when the first frame is pulled from `stream.frames`. If you never iterate `stream.frames`, `stream.done` will never resolve. Use `agent.complete()` whenever you only need the final result.
    ::::

:::

:::tabs-item{icon="i-lucide-check-circle" label="agent.complete() (Buffered)"}
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

::collapsible{name="ChatInput properties"}
:::field-group
::::field{name="message" type="string" required}
The user prompt for this turn.
::::

    ::::field{name="userId" type="string"}
    Owning user ID. Required whenever `conversation` is configured so database rows stay scoped to the owning user.
    ::::

    ::::field{name="conversationId" type="number"}
    Resumes an existing thread. Omit to create a new conversation titled from `message`.
    ::::

    ::::field{name="history" type="readonly HistoryMessage[]"}
    Manual `HistoryMessage[]` list used only for stateless agents (ignored when `conversation` is configured).
    ::::

    ::::field{name="files" type="readonly File[]"}
    Attached files parsed into text and prepended to the user message for this turn. Binary files (images, audio, video, raw binaries) are not supported; see [Attachments & Semantic Cache](/agents/attachments-and-caching#file-attachments).
    ::::

    ::::field{name="runId" type="string"}
    Explicit run identifier when `runs` is enabled. Generated via `crypto.randomUUID()` when omitted.
    ::::

    ::::field{name="signal" type="AbortSignal"}
    Cancellation signal merged with the run's internal stop signal.
    ::::

    ::::field{name="model" type="Partial<Omit<ModelOptions, 'request'>>"}
    Per-turn overrides for `model`, `temperature`, `maxTokens`, `thinkingEffort`, `tools`, or `body` (`request` remains agent-wide).
    ::::

    ::::field{name="meta" type="Partial<TMeta>"}
    Partial metadata shallow-merged over `AgentConfig.meta` for this turn's tool factories.
    ::::

:::
::

#### `ChatInput.user`

Optional context about the person asking, formatted and appended to `systemInstructions` when any field is populated.

::collapsible{name="ChatInput.user properties"}
:::field-group
::::field{name="locale" type="string"}
Locale hint, for example `"en-US"`.
::::

    ::::field{name="timezone" type="string"}
    Timezone hint, for example `"America/New_York"`.
    ::::

    ::::field{name="geo" type="string"}
    Location or region hint for locally relevant answers.
    ::::

    ::::field{name="currentDate" type="string"}
    Explicit current date and time string, rendered as `Current time`.
    ::::

    ::::field{name="other" type="readonly string[]"}
    Additional facts included as a JSON array when non-empty.
    ::::

:::
::

::note
**Prompt additions from `ChatInput.user`.** Each turn builds the first `system` message fresh from `systemInstructions` (never saved to the `messages` table). When you populate any field on `input.user`, `createAgent()` appends this block to `systemInstructions`:

```text [Appended to systemInstructions when input.user is set]
Information about the user:
- Locale: <user.locale>
- Timezone: <user.timezone>
- Geo: <user.geo>
- Current time: <user.currentDate>
- Other: <JSON array of user.other>
```

Only populated fields are included; if `input.user` has no populated fields, nothing is appended. For exact prompt formats injected by attachments, compaction, tool execution, and structured-output repair, see [Attachments & Semantic Cache](/agents/attachments-and-caching#exact-prompt-format-injected-for-attached-files), [Conversations & Compaction](/agents/conversations-and-compaction#exact-prompts-injected-by-compaction), [Low-Level Tool Loop](/tools/tool-loop#injected-prompts-and-error-messages), and [Structured Output](/agents/structured-output#exact-prompts-used-in-validated-json-mode).
::

#### `ChatInput.json` (`JsonOptions<S>`)

Requests raw JSON mode (`response_format: { type: "json_object" }`) or Zod-validated structured output with automatic repair retries.

::collapsible{name="JsonOptions properties"}
:::field-group
::::field{name="validate" type="boolean"}
When `false` or omitted, streams raw JSON text in `ChatTurnResult.text` with no extra validation call. When `true`, validates against `schema`, runs repair retries on mismatch, and populates `ChatTurnResult.structured` (non-streaming). Default: `false`.
::::

    ::::field{name="schema" type="S extends z.ZodType"}
    Zod schema the answer must satisfy. Required when `validate: true`.
    ::::

    ::::field{name="schemaName" type="string"}
    Schema label rendered into repair prompts. Default: `"results"`.
    ::::

    ::::field{name="maxRetries" type="number"}
    Repair attempts after the initial reply fails validation. Default: `2`.
    ::::

    ::::field{name="includeSchemaInPrompt" type="boolean"}
    Whether to include the rendered schema in each repair prompt. Default: `true`.
    ::::

:::
::

### Stream handle (`ChatStream<TStructured>`)

Live stream handle returned by `agent.chat()`.

::collapsible{name="ChatStream properties"}
:::field-group
::::field{name="frames" type="AsyncIterable<SseFrame>"}
Live event stream yielding `init`, `chunk`, `reasoning`, `tool_start`, `tool_end`, `error`, and `done` frames (plus any mid-call `agent_progress` or `workflow_progress` events emitted by tools).
::::

    ::::field{name="done" type="Promise<ChatTurnResult<TStructured>>"}
    Resolves with the final `ChatTurnResult` when the turn finishes, aborts, or fails.
    ::::

:::
::

### Turn output (`ChatTurnResult<TStructured>`)

Resolved by `stream.done` (from `agent.chat()`) and returned directly by `agent.complete()`.

::collapsible{name="ChatTurnResult properties"}
:::field-group
::::field{name="runId" type="string"}
Present when `runs` is enabled.
::::

    ::::field{name="conversationId" type="number"}
    Present when `conversation` persistence is enabled.
    ::::

    ::::field{name="text" type="string"}
    The assistant's final text. Empty when the turn failed before answering.
    ::::

    ::::field{name="toolsUsed" type="readonly string[]"}
    Tool names called by the model during the turn, in order.
    ::::

    ::::field{name="trace" type="(MessageTrace & Record<string, unknown>) | null"}
    Captured reasoning rounds, tool steps, and any fields contributed by configured `trace` extensions, or `null` if nothing was recorded.
    ::::

    ::::field{name="cached" type="boolean"}
    `true` when the answer was served from semantic cache instead of calling the model.
    ::::

    ::::field{name="structured" type="TStructured"}
    Validated object returned only when the turn passed `json: { validate: true, schema }`.
    ::::

    ::::field{name="error" type="Error"}
    Set when a streaming turn failed.
    ::::

:::
::

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
:::card{icon="i-lucide-messages-square" title="Conversations & Compaction" to="/agents/conversations-and-compaction"}
Persist multi-turn threads, replay tool traces across turns, and keep long histories inside token budgets.
:::

:::card{icon="i-lucide-braces" title="Structured Output" to="/agents/structured-output"}
Request raw JSON mode or Zod-validated objects with automatic repair retries.
:::

:::card{icon="i-lucide-paperclip" title="Attachments & Semantic Cache" to="/agents/attachments-and-caching"}
Parse uploaded PDFs, spreadsheets, and text files, and serve near-identical repeated questions from the semantic cache.
:::

:::card{icon="i-lucide-shield-check" title="Durable Agent Runs" to="/agents/agent-runs"}
Back every agent turn with a database lease, Redis event stream, and client reattach support.
:::

:::card{icon="i-lucide-layers" title="Production Agent & Streaming Recipes" to="/agents/production-agent-and-streaming"}
End-to-end kitchen-sink agent plus complete CLI, Web/Node HTTP server, and frontend SSE client consumers.
:::
::
