# Streaming, HTTP Adapters & Tracing (`@riavzon/ai`)

## `SseFrame` / `SseEvent` Wire Protocol

Every SSE event is encoded with `encodeSseFrame(frame)` and sent with `SSE_HEADERS`.

| Event `type` | Emitted When | Key Fields |
| --- | --- | --- |
| `init` | Turn starts | `conversationId` (`runId` is sent by `streamFromRun({ runId })`, or obtained from caller `input.runId` / `ChatTurnResult.runId`) |
| `reasoning` | Model emits reasoning / thinking content | `round`, `delta` |
| `tool_start` | Tool invocation begins | `id`, `name`, `args?` (governed by `ToolStreamPolicy.emitArgs`), `callIndex`, `callTotal` |
| `tool_end` | Tool invocation finishes | `id`, `name`, `ok`, `durationMs`, `preview` (governed by `ToolStreamPolicy.emitResult`) |
| `chunk` | Assistant answer token arrives | `text` |
| `workflow_start` / `workflow_progress` | `AgenticWorkflowLoop` or `workflowStream()` progress | `workflow`, `stage`, `label?`, `round?`, `intent?`, `custom?` |
| `agent_progress` | Custom `ctx.emit(...)` sub-progress inside tools | `agent`, `state` (`"running" \| "done" \| "failed"`) |
| `error` | Recoverable/terminal turn error | `message` |
| `done` | Stream closes cleanly | Terminal frame |

## Web Standard HTTP Adapter (Next.js / Hono / Nitro / Bun)

```ts
import { framesToStream, SSE_HEADERS } from "@riavzon/ai";
import { supportAgent } from "./agent";

export async function POST(req: Request) {
  const { message, conversationId, userId, tenantId } = await req.json();

  const controller = new AbortController();
  const { frames } = supportAgent.chat({
    message,
    conversationId,
    userId,
    meta: { tenantId },
    signal: AbortSignal.any([req.signal, controller.signal]),
  });

  const stream = framesToStream(frames, {
    heartbeatMs: 15_000,
    onCancel: () => controller.abort(),
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
```

## Node.js HTTP Adapter (Express / Fastify)

Use `createRequestAbort({ onDisconnect })` so client disconnects cleanly abort non-detached turns without false positives once the turn completes:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createRequestAbort, framesToStream, SSE_HEADERS } from "@riavzon/ai";
import { supportAgent } from "./agent";

export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  body: { message: string; userId: string; tenantId: string },
) {
  const abort = createRequestAbort({
    meta: { userId: body.userId },
    onDisconnect: (cancel) => {
      req.on("close", () => {
        if (!res.writableEnded) cancel();
      });
    },
  });

  const { frames, done } = supportAgent.chat({
    message: body.message,
    userId: body.userId,
    meta: { tenantId: body.tenantId },
    signal: abort.signal,
  });

  res.writeHead(200, SSE_HEADERS);
  const webStream = framesToStream(frames, {
    heartbeatMs: 15_000,
    onCancel: () => abort.abort(),
  });
  Readable.fromWeb(webStream as any).pipe(res);
  await done;
  abort.markFinished();
}
```

## Typed Frontend SSE Consumer (With `Last-Event-ID` Reconnect)

```ts
import type { SseEvent } from "@riavzon/ai";

export async function streamChat(
  url: string,
  body: Record<string, unknown>,
  onEvent: (ev: SseEvent, eventId?: string) => void,
  opts?: { lastEventId?: string; signal?: AbortSignal },
) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts?.lastEventId ? { "Last-Event-ID": opts.lastEventId } : {}),
    },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      let id: string | undefined;
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue; // heartbeat comment
        if (line.startsWith("id:")) id = line.slice(3).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(JSON.parse(data) as SseEvent, id);
    }
  }
}
```

## Tracing & Custom `TraceExtension`

`TraceCollector` records reasoning rounds and tool steps per turn. Extend it with `TraceExtension<TExtra>` plugins (passed via `createAgent({ trace: [...] })` or `new TraceCollector([...])`) to merge custom telemetry into `ChatTurnResult.trace`:

```ts
import type { AgentEvent, TraceExtension } from "@riavzon/ai";

export function createTimingExtension(): TraceExtension<{ toolDurationMs: number }> {
  let toolDurationMs = 0;
  return {
    apply(event: AgentEvent) {
      if (event.type === "tool_end") toolDurationMs += event.durationMs;
    },
    toTrace() {
      return toolDurationMs > 0 ? { toolDurationMs } : undefined;
    },
  };
}
```

## Low-Level Chat Primitives

When bypassing `createAgent()`, compose turns manually from the same building blocks:
- `resolveConversation()` — create or fetch conversation thread
- `compactHistory()` & `historyToMessages()` — rolling summarization and message formatting
- `tryCachedReply()` — semantic cache lookup
- `createEventSink()` — out-of-band progress emitter
- `runAgentStream()` — orchestrates tool loop + persistence + SSE frames
