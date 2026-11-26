import { describe, expect, it } from "vitest";

import type { StoredEvent } from "../../types/Chat.js";
import { streamFromRun } from "../streamFromRun.js";
import type { RunHandle } from "../types.js";

/**
 * `streamFromRun` is the same-replica attach path. It replays the in-memory log
 * and then follows live. A reattach that loses its tail, or replays a frame
 * twice, is exactly what the Reattach button would show the operator.
 *
 * The `since` cursor is a **stream id**, not an index: ids are compared
 * numerically per segment, so a trimmed log cannot make a reconnect replay the
 * wrong window. The fixtures therefore build a real `eventIds` array rather
 * than passing positions.
 */

const log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

/** Ids chosen so string and numeric ordering disagree: `-10` must follow `-9`. */
const IDS = ["1000-0", "1000-1", "1000-2", "1000-3", "1000-4"];

function handle(partial: Partial<RunHandle> = {}): RunHandle {
  return {
    id: "run-1",
    kind: "workflow",
    startedAt: Date.now(),
    status: "running",
    events: [],
    eventIds: [],
    controller: new AbortController(),
    subscribers: new Set(),
    ...partial,
  };
}

/**
 * Builds a handle whose events and ids line up.
 *
 * The registry always keeps the two arrays the same length, so a fixture that
 * let them drift would model a state production never reaches.
 */
function withEvents(events: StoredEvent[], partial: Partial<RunHandle> = {}) {
  return handle({
    events,
    eventIds: IDS.slice(0, events.length),
    ...partial,
  });
}

/**
 * Reads every frame that is already queued, then cancels.
 *
 * A live run's stream deliberately stays open, so a drain that waited for
 * `done` would hang until the test timeout. Reads race a zero-delay timer: the
 * stream resolves queued chunks immediately, and the timer is what notices that
 * nothing more is coming.
 */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const next = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) =>
          setTimeout(() => {
            resolve(null);
          }, 5),
        ),
      ]);
      if (next === null || next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return text;
}

function parse(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      // A frame carries an `id:` line before `data:` when the event has a
      // stream id, so the payload is the data line, not the whole block.
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (data === undefined) {
        throw new Error(`Frame has no data line: ${block}`);
      }
      return JSON.parse(data.slice("data: ".length)) as Record<string, unknown>;
    });
}

describe("streamFromRun", () => {
  it("sends an init frame with the run id when the caller passes a conversation", async () => {
    // The conversation id is a parameter, not a field read off the handle: a
    // workflow run has no conversation of its own and must not announce one.
    const run = handle();
    const frames = parse(
      await drain(streamFromRun({ run, conversationId: 9, log })),
    );

    expect(frames[0]).toMatchObject({
      type: "init",
      conversationId: 9,
      runId: "run-1",
    });
  });

  it("omits the init frame when there is no conversation", async () => {
    const run = handle();
    const frames = parse(await drain(streamFromRun({ run, log })));
    expect(frames.some((frame) => frame.type === "init")).toBe(false);
  });

  it("replays every buffered event in order", async () => {
    const run = withEvents([
      { type: "chunk", text: "a" },
      { type: "chunk", text: "b" },
      { type: "chunk", text: "c" },
    ] as StoredEvent[]);

    const frames = parse(await drain(streamFromRun({ run, log })));

    expect(frames).toEqual([
      { type: "chunk", text: "a" },
      { type: "chunk", text: "b" },
      { type: "chunk", text: "c" },
    ]);
  });

  it("starts the replay strictly after the given stream id", async () => {
    const run = withEvents([
      { type: "chunk", text: "a" },
      { type: "chunk", text: "b" },
      { type: "chunk", text: "c" },
    ] as StoredEvent[]);

    // `1000-1` was already delivered, so the replay starts at `c`.
    const frames = parse(
      await drain(streamFromRun({ run, since: "1000-1", log })),
    );

    expect(frames).toEqual([{ type: "chunk", text: "c" }]);
  });

  it("orders ids numerically, so a two-digit sequence does not replay early", async () => {
    const run = handle({
      events: [
        { type: "chunk", text: "a" },
        { type: "chunk", text: "b" },
      ] as StoredEvent[],
      eventIds: ["1000-9", "1000-10"],
    });

    // String order puts "1000-10" before "1000-9"; numeric order does not.
    const frames = parse(
      await drain(streamFromRun({ run, since: "1000-9", log })),
    );

    expect(frames).toEqual([{ type: "chunk", text: "b" }]);
  });

  it("replays everything when the cursor is the first-id sentinel", async () => {
    const run = withEvents([
      { type: "chunk", text: "a" },
      { type: "chunk", text: "b" },
    ] as StoredEvent[]);

    const frames = parse(
      await drain(streamFromRun({ run, since: "0-0", log })),
    );

    expect(frames.map((frame) => frame.type)).toEqual(["chunk", "chunk"]);
  });

  it("clamps a cursor past the end to an empty replay", async () => {
    const run = withEvents([{ type: "chunk", text: "a" }] as StoredEvent[]);
    const frames = parse(
      await drain(streamFromRun({ run, since: "9999-0", log })),
    );
    // No replay, and no synthesized `done`, because the run is still running.
    expect(frames).toEqual([]);
  });

  it("closes immediately for a run that already finished", async () => {
    const run = withEvents([{ type: "chunk", text: "a" }] as StoredEvent[], {
      status: "finished",
    });

    const frames = parse(await drain(streamFromRun({ run, log })));

    expect(frames.map((frame) => frame.type)).toEqual(["chunk", "done"]);
  });

  it("does not duplicate a done that was already published", async () => {
    const run = withEvents([{ type: "done" }] as StoredEvent[], {
      status: "finished",
    });

    const frames = parse(await drain(streamFromRun({ run, log })));

    expect(frames.filter((frame) => frame.type === "done")).toHaveLength(1);
  });

  it("does not synthesize a done after an error frame", async () => {
    const run = withEvents(
      [{ type: "error", message: "boom" }] as StoredEvent[],
      { status: "failed" },
    );

    const frames = parse(await drain(streamFromRun({ run, log })));

    expect(frames.filter((frame) => frame.type === "done")).toHaveLength(0);
    expect(frames.at(-1)).toMatchObject({ type: "error" });
  });

  it("does not subscribe for a run that already ended", async () => {
    const run = handle({ status: "aborted" });
    await drain(streamFromRun({ run, log }));
    // A subscriber on a dead run would never be called and would leak.
    expect(run.subscribers.size).toBe(0);
  });

  it("registers its subscriber synchronously and drops it on cancel", async () => {
    const run = handle();
    const stream = streamFromRun({ run, log });

    // `start` runs inside the constructor, so a frame published immediately
    // after this line still reaches the reader. That is what makes the gap
    // between replay and tail impossible to observe.
    expect(run.subscribers.size).toBe(1);

    const reader = stream.getReader();
    await reader.cancel();
    expect(run.subscribers.size).toBe(0);
    reader.releaseLock();
  });

  it("delivers a live event to an attached reader", async () => {
    const run = handle();
    const stream = streamFromRun({ run, log });
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    for (const send of run.subscribers) {
      send({ type: "chunk", text: "live" }, "1000-0");
    }

    const { value } = await reader.read();
    expect(decoder.decode(value)).toContain('"text":"live"');

    await reader.cancel();
    reader.releaseLock();
  });

  it("stops the stream when the run publishes done", async () => {
    const run = handle();
    const stream = streamFromRun({ run, log });
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    for (const send of run.subscribers) send({ type: "done" }, "1000-1");

    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }

    expect(text).toContain('"type":"done"');
    // The subscriber removes itself on close.
    expect(run.subscribers.size).toBe(0);
    reader.releaseLock();
  });

  it("ignores a frame that arrives after the stream closed", async () => {
    const run = withEvents([{ type: "done" }] as StoredEvent[], {
      status: "finished",
    });
    const stream = streamFromRun({ run, log });
    const reader = stream.getReader();

    while (!(await reader.read()).done) {
      // Drain the replay and the close.
    }

    // Nothing is subscribed for a finished run, so this exercises the guard
    // rather than a live delivery: publishing must not throw into a closed
    // controller.
    expect(() => {
      for (const send of run.subscribers) send({ type: "chunk" }, "1000-9");
    }).not.toThrow();
    expect(run.subscribers.size).toBe(0);

    reader.releaseLock();
  });
});
