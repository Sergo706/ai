---
title: Streaming & SSE
description: Stream agent turns and long-running workflows over Server-Sent Events (SSE) with keep-alive heartbeats, typed frames, and clean HTTP helpers.
navigation:
  icon: i-lucide-radio
seo:
  title: SSE Streaming & Frame Helpers — Riavzon AI
  description: Encode SSE frames, set streaming response headers, convert agent turns with framesToStream(), and stream long workflows with workflowStream() in @riavzon/ai.
---

Because `@riavzon/ai` never mounts HTTP routes or assumes a web framework, streaming primitives return standard Web API `ReadableStream<Uint8Array>` bodies and plain header objects. You can hand them directly to `new Response(...)` in Next.js, Nuxt/Nitro, Hono, Fastify, Express, or Bun.

## Wire format & frame helpers

Every frame sent by `@riavzon/ai` uses standard Server-Sent Events (`text/event-stream`) with JSON payloads inside `data:` lines and optional `id:` cursors for resume support.

```ts [src/sse-basics.ts]
import { encode, frame, setSseHeaders, SSE_HEARTBEAT } from "@riavzon/ai";

// Encodes: 'data: {"type":"chunk","text":"Hello"}\n\n'
const basic = frame({ type: "chunk", text: "Hello" });

// Encodes with event ID cursor for Last-Event-ID replay:
// 'id: 1712345678900-0\ndata: {"type":"chunk","text":"Hello"}\n\n'
const cursorFrame = frame({ type: "chunk", text: "Hello" }, "1712345678900-0");

// UTF-8 Uint8Array for ReadableStream controllers
const bytes: Uint8Array = encode(cursorFrame);

// Keep-alive comment line: ": heartbeat\n\n"
const heartbeatBytes: Uint8Array = encode(SSE_HEARTBEAT);

// Standard proxy-safe SSE headers
const headers = setSseHeaders();
// {
//   "Content-Type": "text/event-stream",
//   "Cache-Control": "no-cache",
//   "Connection": "keep-alive",
//   "X-Accel-Buffering": "no",
//   "Transfer-Encoding": "chunked"
// }
```

## Event types (`AgentEvent` & `SseEvent`)

Every streaming turn emits a discriminated union of typed frames on `data:`:

| Frame `type` | Payload fields | Meaning |
| --- | --- | --- |
| `init` | `conversationId: number`, `runId?: string` | First frame of a chat turn; gives the client the persisted thread and run IDs. |
| `chunk` | `text: string` | Incremental assistant output token or complete cached text. |
| `reasoning` | `round: number`, `delta: string` | Reasoning delta emitted by thinking-capable models. |
| `tool_start` | `id`, `name`, `args?`, `callIndex`, `callTotal` | Tool call began (`args` omitted when `ToolStreamPolicy.emitArgs` is `false`). |
| `tool_end` | `id`, `name`, `ok`, `durationMs`, `preview`, `callIndex`, `callTotal` | Tool call finished (`preview` trimmed or omitted per `ToolStreamPolicy.emitResult`). |
| `workflow_start` | `runId`, `workflow`, `query` | Long-running workflow started (emitted via `runProgressFrames()`). |
| `workflow_progress` | `runId?`, `workflow`, `stage`, `label?`, `addedEvidence`, `round?`, `intent?`, `message?`, `custom?` | Progress event from an `AgenticWorkflowLoop` adapter. |
| `agent_progress` | `agent`, `state` (`"running" \| "done" \| "failed"`) | Named sub-agent status update inside a workflow. |
| `error` | `message: string` | Terminal error message safe to display to end users. |
| `done` | *(none)* | Terminal frame signaling a completed stream. |

## Choose the right streaming helper

`@riavzon/ai` provides seven streaming builders covering everything from simple chat routes to cross-replica crash-resumable workflows:

| Helper | Input | Default heartbeat | `id:` cursors | Durable / reattach | Client disconnect behavior | Best for |
| --- | --- | --- | --- | --- | --- | --- |
| `framesToStream()` | `AsyncIterable<SseFrame>` from `agent.chat()` | `10_000` ms | No | Yes when `AgentConfig.runs` is on (omit `onCancel`) | Calls `onCancel()` if provided | Any route backed by `createAgent()` |
| `runAgentStream()` | `AsyncIterable<AgentEvent>` + `EventSink` + `TraceCollector` | None (add via custom wrapper if needed) | No | No | Cancels via `RequestAbort` / `signal` | Custom low-level chat pipelines without `createAgent()` |
| `workflowStream()` | `execute(emit) => Promise<SseFrame>` | `15_000` ms | No | No | Closes response (work runs to completion unless you pass a signal) | Simple streaming workflows that do not need client reconnect |
| `workflowStreamWithRegistry()` | `runId`, `kind`, `execute({ emit, signal })` | `10_000` ms | Yes (via registry) | Yes (`streamFromRun` / `streamFromStore`) | Detaches reader while work keeps running until stopped via `run.controller` | Durable workflows launched from an HTTP request with reattach + stop button |
| `streamFromRun()` | Local `RunHandle` from `getRun(runId)` | `10_000` ms | Yes | Yes (same-process replay + live tail) | Unsubscribes reader; run keeps executing | Fast-path reattach when the run lives on this replica |
| `streamFromStore()` | `runId`, `since`, `isRunAlive` | `10_000` ms | Yes | Yes (cross-replica Redis Streams replay + live tail) | Stops tail loop; run keeps executing | Reattach when the request lands on another replica or after restart |
| `staticReplyStream()` | `(conversationId, text)` | None | No | No | Closes immediately after `done` | Instant replay of semantically cached or static chat replies |

## Streaming helpers

Pick the streaming builder that matches your use case — from high-level `agent.chat()` streams down to custom workflow streams and static cache replays.

::tabs
  :::tabs-item{label="framesToStream (agent.chat)" icon="i-lucide-bot"}
  Convert the `AsyncIterable<SseFrame>` returned by `agent.chat()` into an HTTP `ReadableStream<Uint8Array>` with automatic keep-alive heartbeats (default `10000` ms) and reader-disconnect cleanup:

  ```ts [src/routes/agent-sse.ts]
  import { framesToStream, setSseHeaders } from "@riavzon/ai";

  export async function POST(req: Request): Promise<Response> {
    const { message, userId, conversationId } = await req.json();
    const controller = new AbortController();

    const { frames } = await agent.chat({
      message,
      userId,
      conversationId,
      signal: controller.signal,
    });

    return new Response(
      framesToStream(frames, {
        heartbeatMs: 10_000,
        // Pass onCancel for non-durable turns so disconnecting aborts the LLM call.
        // Omit onCancel when agent runs are enabled so clients can reattach later.
        onCancel: () => controller.abort(),
      }),
      { headers: setSseHeaders() },
    );
  }
  ```
  :::

  :::tabs-item{label="workflowStream (Long Tasks)" icon="i-lucide-workflow"}
  Wrap any async workflow in an SSE body with periodic heartbeats (default `15000` ms), automatic terminal payload + `done` emission, and safe error-to-frame conversion:

  ```ts [src/routes/research-sse.ts]
  import {
    runProgressFrames,
    setSseHeaders,
    workflowStream,
  } from "@riavzon/ai";

  export async function POST(req: Request): Promise<Response> {
    const { query } = await req.json();

    const stream = workflowStream({
      heartbeatMs: 15_000,
      execute: async (emit) => {
        const progress = runProgressFrames(emit, {
          query,
          workflow: "research",
        });

        progress.onRunStarted(crypto.randomUUID());
        progress.onAgentProgress({ agent: "planner", state: "running" });

        const report = await runMyResearch(query, progress.onProgress);

        progress.onAgentProgress({ agent: "planner", state: "done" });
        return { type: "research_result", report };
      },
      onError: (err) => console.error("Research workflow failed", err),
    });

    return new Response(stream, { headers: setSseHeaders() });
  }
  ```
  :::

  :::tabs-item{label="staticReplyStream (Instant Replay)" icon="i-lucide-zap"}
  Emit a pre-computed or semantically cached reply in the exact same SSE framing (`init` → single `chunk` → `done`) so clients never need a second parser:

  ```ts [src/routes/cached-sse.ts]
  import { setSseHeaders, staticReplyStream } from "@riavzon/ai";

  export function cachedResponse(conversationId: number, answer: string): Response {
    return new Response(staticReplyStream(conversationId, answer), {
      headers: setSseHeaders(),
    });
  }
  ```
  :::
::

## Type custom workflow and sub-agent names

`WorkflowName` and `WorkflowAgent` support TypeScript declaration merging through the empty `WorkflowNameRegistry` and `WorkflowAgentRegistry` interfaces. Augment them once in your project to get strict autocomplete across `runProgressFrames()` and `AgentEvent` frames:

```ts [src/types/ai-augmentation.d.ts]
declare module "@riavzon/ai" {
  interface WorkflowNameRegistry {
    research: true;
    audit: true;
  }

  interface WorkflowAgentRegistry {
    planner: true;
    crawler: true;
    synthesizer: true;
  }
}

export {};
```

## Explore streaming & chat internals

::card-group
  :::card
  ---
  icon: i-lucide-blocks
  title: Low-Level Chat Primitives
  to: /sse/chat-primitives
  ---
  Compose `runAgentStream()`, `createEventSink()`, `resolveConversation()`, `compactHistory()`, and `tryCachedReply()` inside your own custom chat pipeline.
  :::

  :::card
  ---
  icon: i-lucide-activity
  title: Trace Collection & Abort Control
  to: /sse/trace-and-abort
  ---
  Record reasoning and tool steps with `TraceCollector`, extend traces with `TraceExtension`, and handle HTTP disconnects cleanly with `createRequestAbort()`.
  :::
::
