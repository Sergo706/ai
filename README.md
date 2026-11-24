# @riavzon/ai

An embeddable TypeScript agent runtime. It owns the agent loop, the tool
protocol, retrieval, and the run lifecycle, and leaves the rest to you.

There is no framework underneath it. The package never opens a port, never
mounts a route, and never hides a prompt. You pass in an OpenAI-compatible
client, a database, and an optional cache, then decide how requests arrive and
how responses leave. The same build runs against a zero-config SQLite file or a
multi-replica PostgreSQL and Redis Streams deployment, with no code change
between the two.

Every heavy dependency is an optional peer. `pdf-lib`, `exceljs`, `ioredis`,
`better-sqlite3`, `sqlite-vec`, `@modelcontextprotocol/client`, and the rest load
on first use, so a project that only needs chat installs only chat.

## Features

| Area            | What it does                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Agents          | One reusable agent built once, then turn after turn with tools, attachments, memory, and structured output. |
| Tool calling    | A bounded loop over rounds and calls, with caching, concurrency limits, and streamed tool events.           |
| MCP             | Model Context Protocol servers become ordinary, executable tools.                                           |
| RAG             | Chunking, embedding, adaptive filtering, and vector search on pgvector or `sqlite-vec`.                     |
| Workflow agents | A budgeted, multi-stage loop for research-style tasks, with pluggable stage adapters.                       |
| Runs            | Durable run records with leases, event logs, checkpoints, and crash recovery.                               |
| Storage         | Kysely with SQLite or PostgreSQL, one schema, one API.                                                      |

## Installation

```bash [Terminal]
npm install @riavzon/ai
```

Install the peers you actually use. `openai` is required for chat and
embeddings; everything else is optional.

```bash [Terminal]
npm install openai
```

The package ships ESM and CommonJS builds with matching type declarations, so
either module system resolves the same API.

## Getting started

Call `configuration()` once at startup. It validates the config, opens the
database, runs migrations, and prepares the cache.

```ts [boot.ts]
import OpenAI from "openai";
import { configuration } from "@riavzon/ai";

await configuration({
  db: "./data/app.db",
  openAiConfig: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  embeddingConfig: {
    dimensions: 1536,
    matchingModel: "text-embedding-3-small",
    retrievalModel: "text-embedding-3-small",
  },
});
```

`db` accepts a SQLite path or a `pg` `Pool`. A path gets WAL mode, migrations,
and `sqlite-vec` loaded for you. `redis` defaults to `"memory"`, which is enough
for a single process.

> **Note:** Configuration is global and required. Modules read it lazily, so
> `configuration()` must run before any agent, model, or run function is called.

## Agents

An agent is built once and reused. Construction resolves the model, validates
the config, connects MCP servers, and assembles the tool registry, so a mistake
fails at startup rather than on the first user request.

```ts [agent.ts]
import { createAgent } from "@riavzon/ai";

const agent = await createAgent({
  model: { model: "gpt-4o-mini" },
  systemInstructions: "You answer in one short paragraph.",
  tools: { common: ["calculator", "get_current_datetime"] },
});

const { text, toolsUsed } = await agent.complete({ message: "What is 2 + 2?" });
await agent.close();
```

Each turn is one of two shapes. `agent.chat()` returns a stream of typed frames
that you forward as Server-Sent Events, WebSocket messages, or terminal output.
`agent.complete()` drains the same stream and resolves with the final result, so
a script and an HTTP handler share one code path.

Tools come from three places: the built-in set, your own `ToolSpec` objects, and
MCP servers. A spec builds a fresh handler per request, so it can capture the
user, the conversation, or a connection that only exists for that turn.

```ts [tools.ts]
const weather = {
  name: "get_weather",
  definitions: {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  },
  make:
    () =>
    async ({ city }) =>
      fetchWeather(String(city)),
  cache: { ttl: 600 },
};
```

A turn can also persist its history, compact it when it grows, answer from a
semantic cache, validate a JSON reply against a Zod schema, and record a trace
of reasoning and tool steps. Those are opt-in fields on the config, not defaults
you have to undo.

## MCP tools

Point the agent at one or more MCP servers and their tools arrive ready to run.

```ts [agent.ts]
const agent = await createAgent({
  model: { model: "gpt-4o-mini" },
  tools: {
    mcp: [{ url: "https://mcp.example.com/mcp", namespace: "ex" }],
  },
});
```

Each server tool becomes an OpenAI function definition and a matching
`ToolSpec` whose handler calls back on the live connection. Namespacing keeps
tool names unique, exclusion lists hide the tools you do not want, and a
per-server policy applies a cache TTL, a call cap, and a concurrency limit to
every tool from that server.

## RAG

The retrieval helpers cover the whole path from raw text to searchable chunks,
and the same code runs on both database dialects.

```ts [rag.ts]
import { generateEmbedding, prepareScrape } from "@riavzon/ai";

const prepared = await prepareScrape(title, markdown, jsonData, {
  maxTokens: 1000,
  overlapTokens: 100,
});

const embedding = await generateEmbedding("how do leases work");
```

`chunkByTokens` splits text on paragraph and line boundaries with a token budget
and an overlap. `prepareScrape` chunks a page, embeds each chunk, and returns
rows ready to insert. `filterAdaptiveChunks` scores candidates against the query
by cosine similarity, rejects near-duplicates, and returns only the chunks worth
storing.

Search is dialect-aware. `toVec` writes a pgvector literal on PostgreSQL and a
`Float32Array` blob on SQLite, so the same query code returns `RelevantChunk`
rows either way.

## Workflow agents

A workflow agent handles tasks that cannot finish in one model call. It runs
repeated rounds of gathering, judging, and deciding, and stops when the evidence
is sufficient or a budget runs out.

The loop itself owns the control flow. You supply adapters for the work: where
local evidence comes from, how a search intent is discovered, which targets to
execute, and whether the result is good enough.

```ts [research.ts]
import { AgenticWorkflowLoop } from "@riavzon/ai";

const loop = new AgenticWorkflowLoop({
  name: "research",
  query,
  budgets: { maxLocalRounds: 3, maxExternalRounds: 5 },
  localKnowledge,
  externalDiscovery,
  targetExecutor,
  evaluator,
  critic,
  finalAnswer,
});

const result = await loop.run();
```

`WorkflowBudgets` caps every stage, so a run always terminates even if an
adapter never reports success. Progress is reported through a single `emit`
callback, and each event carries the stage that produced it, which is enough to
drive a progress UI without exposing the loop internals.

## The run system

Chat turns and workflow runs can be stored as durable records. A run survives
a dropped connection, a rolling deploy, and a process crash, and a client can
reattach to it from another replica. Four pieces make that work.

### Runner

`runWorkflow` and the agent's run path write a `runs` row before doing any
work, claim it with a lease, heartbeat the claim while the work runs, and record
a terminal status at the end. `pumpRun` drains the agent loop independently of
any HTTP response, which is what lets the work continue after the browser
leaves.

### Resumer

`registerRunResumer` teaches the recovery sweep how to restart one kind of run,
or one named runner within a kind. The sweep itself, started by
`startRunRecovery`, looks for rows whose owner stopped renewing its lease, and
adopts them within a fraction of a lease. A manual `retryRun` restarts an
`aborted` or `failed` run at the user's request, which the sweep never touches.

### Checkpoints

`checkpoint()` wraps a workflow's own progress in an envelope, and
`saveCheckpoint` persists it. A resumed run calls `restore` to copy that progress
back into a freshly built state, so budgets and thresholds come from the current
deployment while only the progress is restored. A run without a checkpoint
starts over.

### Boot

`startRuns` ties the three together. It closes stale rows left behind by a
previous process, then starts the recovery sweep. Call it once per process,
after `configuration()`, and register every resumer first so the sweep knows
what it is allowed to adopt.

```ts [boot.ts]
import { registerRunResumer, startRuns } from "@riavzon/ai";

registerRunResumer({
  kind: "workflow",
  name: "research",
  adopt: resumeResearch,
});

const stopRuns = startRuns();
process.on("SIGTERM", () => stopRuns());
```

Progress is written to an event store that also survives the process. Each run's
log lives in Redis Streams or in a bounded in-process cache, and `streamFromRun`
replays the log and then follows it live, so a client that attaches late sees the
same sequence as one that never left. `streamFromStore` serves a run held by
another replica.

> **Tip:** Run leases make the multi-replica path safe without a coordinator.
> One instance holds the claim on a run, the heartbeat proves it is alive, and a
> second instance only takes over once the lease expires.

## Configuration

`configuration()` accepts the database, the OpenAI client, embedding dimensions
and models, a cache backend, and a logger. Only `db`, `openAiConfig`, and
`embeddingConfig` are required; everything else has a default.

Tuning for leases, registry retention, event logs, and the recovery sweep lives
under `runs` and falls back to defaults derived from the lease itself, so
changing the lease never leaves a sweep looking too late. Environment variables
mirror those settings as `RUNS_*` for deployments that prefer them.

## Documentation

The full API surface carries hover documentation, so an editor shows signatures,
defaults, and examples without leaving the file. Start with the exported
modules: `agents`, `tools`, `rag`, `agentic-loop`, `runs`, and `config`.

## License

MIT License
