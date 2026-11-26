import { describe, expect, it } from "vitest";
import {
  frame,
  runProgressFrames,
  setSseHeaders,
  SSE_HEARTBEAT,
  workflowStream,
} from "../sse.js";
/**
 * Route identities.
 *
 * The library types a workflow name as a plain string — the app narrows it with
 * its own registry — so the test names the three routes it exercises instead of
 * importing the app's enum.
 */
const RESEARCH_WORKFLOW = "deepResearch";
const PRODUCT_WORKFLOW = "productResearch";
const AGENTIC_TEAM_WORKFLOW = "agenticTeam";

async function drain(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: string[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  buffer += decoder.decode();

  for (const block of buffer.split("\n\n")) {
    if (block.trim() === "") continue;
    frames.push(block);
  }
  return frames;
}

function payload(
  frameText: string,
): { type: string } & Record<string, unknown> {
  const line = frameText.split("\n").find((part) => part.startsWith("data: "));
  if (!line) throw new Error(`Frame has no data line: ${frameText}`);
  return JSON.parse(line.slice("data: ".length)) as {
    type: string;
  } & Record<string, unknown>;
}

describe("frame", () => {
  it("wraps a payload in a single SSE data line ending with a blank line", () => {
    expect(frame({ type: "done" })).toBe('data: {"type":"done"}\n\n');
  });

  it("preserves newlines inside string values by JSON escaping them", () => {
    // A raw newline would split the frame in two and the client would parse the
    // second half as a malformed event, so this has to survive as \n.
    const encoded = frame({ type: "chunk", text: "line one\nline two" });
    expect(encoded).toBe(
      'data: {"type":"chunk","text":"line one\\nline two"}\n\n',
    );
    expect(encoded.split("\n\n")).toHaveLength(2);
  });

  it("keeps a payload's own type field rather than overwriting it", () => {
    const parsed = payload(
      frame({ type: "research_result", success: true, source: "web" }),
    );
    expect(parsed).toEqual({
      type: "research_result",
      success: true,
      source: "web",
    });
  });
});

describe("setSseHeaders", () => {
  it("declares an event stream", () => {
    // The helper returns a plain header map, so the caller can hand it to any
    // framework's response object without this module depending on one.
    const headers = setSseHeaders();

    expect(headers["Content-Type"]).toBe("text/event-stream");
  });

  it("prevents any hop from buffering the frames", () => {
    const headers = setSseHeaders();

    // `no-cache` alone is not enough: a proxy that buffers turns a live
    // stream into one delivery at the end, so both headers are needed.
    expect(headers["Cache-Control"]).toBe("no-cache");
    expect(headers["X-Accel-Buffering"]).toBe("no");
  });

  it("keeps the connection open", () => {
    const headers = setSseHeaders();

    expect(headers.Connection).toBe("keep-alive");
    expect(headers["Transfer-Encoding"]).toBe("chunked");
  });

  it("sets exactly those five headers", () => {
    // A stray header here is a stray header on every streamed response.
    expect(Object.keys(setSseHeaders()).sort()).toEqual([
      "Cache-Control",
      "Connection",
      "Content-Type",
      "Transfer-Encoding",
      "X-Accel-Buffering",
    ]);
  });
});

describe("runProgressFrames", () => {
  it("announces the run id on workflow_start and repeats it on every page", () => {
    const sent: Record<string, unknown>[] = [];
    const { onRunStarted, onProgress } = runProgressFrames(
      (payload_) => sent.push(payload_),
      { query: "battery rules", workflow: RESEARCH_WORKFLOW },
    );

    onRunStarted("run-1");
    onProgress({
      label: "https://example.com/a",
      custom: {
        url: "https://example.com/a",
        title: "A",
        favicon: "https://icons.example/a.ico",
      },
      addedEvidence: true,
    });
    onProgress({
      label: "https://example.com/b",
      custom: { url: "https://example.com/b", title: "B", favicon: "" },
      addedEvidence: false,
    });

    expect(sent[0]).toEqual({
      type: "workflow_start",
      query: "battery rules",
      workflow: RESEARCH_WORKFLOW,
      runId: "run-1",
    });
    // The id is repeated so a client that attached mid-run can still abort or
    // retry; without this the page frames are anonymous.
    expect(sent[1]).toMatchObject({
      type: "workflow_progress",
      runId: "run-1",
    });
    expect(sent[2]).toMatchObject({
      type: "workflow_progress",
      runId: "run-1",
    });
  });

  it("carries the route's workflow name on every progress frame", () => {
    const sent: Record<string, unknown>[] = [];
    const { onProgress } = runProgressFrames(
      (payload_) => sent.push(payload_),
      { query: "q", workflow: PRODUCT_WORKFLOW },
    );

    onProgress({
      label: "https://example.com/a",
      custom: { url: "https://example.com/a", title: "A", favicon: "" },
      addedEvidence: true,
    });

    expect(sent[0]).toMatchObject({ workflow: PRODUCT_WORKFLOW });
  });

  it("omits runId instead of sending undefined when the run never started", () => {
    const sent: Record<string, unknown>[] = [];
    const { onProgress } = runProgressFrames(
      (payload_) => sent.push(payload_),
      { query: "q", workflow: PRODUCT_WORKFLOW },
    );

    onProgress({
      label: "https://example.com/a",
      custom: { url: "https://example.com/a" },
      addedEvidence: true,
    });

    expect(sent[0]).not.toHaveProperty("runId");
    expect(sent[0]).toMatchObject({
      type: "workflow_progress",
      custom: { url: "https://example.com/a" },
    });
  });

  it("reports each fan-out generator so a client can draw one card per agent", () => {
    const sent: Record<string, unknown>[] = [];
    const { onRunStarted, onAgentProgress } = runProgressFrames(
      (payload_) => sent.push(payload_),
      { query: "q", workflow: AGENTIC_TEAM_WORKFLOW },
    );

    onRunStarted("run-team");
    onAgentProgress({ agent: "research", state: "running" });
    onAgentProgress({ agent: "research", state: "done" });
    onAgentProgress({ agent: "video", state: "failed" });
    expect(sent[0]).toMatchObject({ workflow: AGENTIC_TEAM_WORKFLOW });
    expect(sent[1]).toEqual({
      type: "agent_progress",
      agent: "research",
      state: "running",
      runId: "run-team",
    });
    expect(sent[2]).toMatchObject({ agent: "research", state: "done" });
    expect(sent[3]).toMatchObject({ agent: "video", state: "failed" });
  });

  it("omits runId on the generator frames when the run never started", () => {
    const sent: Record<string, unknown>[] = [];
    const { onAgentProgress } = runProgressFrames(
      (payload_) => sent.push(payload_),
      { query: "q", workflow: AGENTIC_TEAM_WORKFLOW },
    );

    onAgentProgress({ agent: "product", state: "running" });
    expect(sent[0]).not.toHaveProperty("runId");
  });
});

describe("workflowStream", () => {
  it("emits the result frame then done, and closes", async () => {
    const stream = workflowStream({
      execute: async () => ({ type: "research_result", success: true }),
    });

    const frames = await drain(stream);

    expect(frames.map(payload)).toEqual([
      { type: "research_result", success: true },
      { type: "done" },
    ]);
  });

  it("streams progress emitted before the result", async () => {
    const stream = workflowStream({
      execute: async (emit) => {
        emit({ type: "research_start", runId: "run-1" });
        emit({ type: "research_url", url: "https://example.com/a" });
        return { type: "research_result", success: true };
      },
    });

    const parsed = (await drain(stream)).map(payload);

    expect(parsed.map((event) => event.type)).toEqual([
      "research_start",
      "research_url",
      "research_result",
      "done",
    ]);
  });

  it("turns a throw into one error frame and never emits done", async () => {
    const logged: unknown[] = [];
    const stream = workflowStream({
      execute: async () => {
        throw new Error("provider exploded");
      },
      onError: (err) => logged.push(err),
    });

    const parsed = (await drain(stream)).map(payload);

    // A `done` after an `error` would make the client treat a failed run as a
    // complete one, so exactly one terminal frame must exist.
    expect(parsed).toEqual([
      { type: "error", message: "Server error please try again" },
    ]);
    expect(logged).toHaveLength(1);
    expect((logged[0] as Error).message).toBe("provider exploded");
  });

  it("does not leak the underlying error message to the client", async () => {
    const stream = workflowStream({
      execute: async () => {
        throw new Error("postgres://user:secret@internal/table missing");
      },
    });

    const [only] = (await drain(stream)).map(payload);

    expect(JSON.stringify(only)).not.toContain("secret");
  });

  it("writes heartbeats as comments, not data frames", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const stream = workflowStream({
      heartbeatMs: 5,
      execute: async () => {
        await gate;
        return { type: "research_result" };
      },
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const text = decoder.decode(first.value);

    expect(text).toContain(SSE_HEARTBEAT);
    expect(text).not.toContain("data:");

    release?.();
    await reader.cancel();
  });

  it("stops writing when the consumer has gone, instead of throwing", async () => {
    let emitted = 0;
    const stream = workflowStream({
      heartbeatMs: 5,
      execute: async (emit) => {
        for (let i = 0; i < 100; i++) {
          emit({
            type: "research_url",
            url: `https://example.com/${String(i)}`,
          });
          emitted++;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        return { type: "research_result" };
      },
    });
    const reader = stream.getReader();
    await reader.read();
    // The cancellation is what a browser does when the tab closes mid-run.
    await reader.cancel();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // The loop keeps going -- that is the run's business -- but the encoder must
    // not be asked to write into a closed controller. Getting here without an
    // unhandled rejection is the assertion.
    expect(emitted).toBeGreaterThan(0);
  });

  it("stops the heartbeat too once the consumer has gone", async () => {
    let released = false;
    const stream = workflowStream({
      heartbeatMs: 5,
      execute: async () => {
        // Nothing is emitted, so the only writer is the heartbeat itself. That
        // is the one that discovers the cancellation first.
        while (!released)
          await new Promise((resolve) => setTimeout(resolve, 1));
        return { type: "research_result" };
      },
    });

    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    released = true;

    // The interval keeps firing after the cancel, so the heartbeat's own catch
    // is what has to notice. Surviving to here without a throw is the point.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(released).toBe(true);
  });
});
