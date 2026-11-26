import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "~~/test/test-utils/config";
import { libLog, libLogger } from "~~/test/test-utils/logger";

/**
 * The chat scaffolding: compaction watermark persistence, the event sink, the
 * disconnect guard, conversation resolution and attachment parsing.
 *
 * Everything here runs for real — the compaction writer and conversation loader
 * hit the real sqlite database the units project configures, and the PDF reader
 * parses a PDF this test builds. Only the two document readers that need a
 * fixture format this suite cannot synthesise (xlsx) are stubbed, and even then
 * the stub replaces the *parse*, not the tool logic.
 */

type ChatModule = typeof import("../conversation.js");
type CompactionModule = typeof import("../compaction.js");

interface Harness {
  resolveConversation: ChatModule["resolveConversation"];
  makeCompactionHandler: CompactionModule["makeCompactionHandler"];
  db: ReturnType<typeof import("../../config/config.js").getDb>;
  cleanup: () => Promise<void>;
}

/**
 * These modules read the database and the logger from the process-wide
 * configuration, so they have to be imported after it exists.
 */
async function boot(): Promise<Harness> {
  // `libLogger` is the shared spy instance, so the assertions below can read the
  // log lines production actually emitted.
  const env = await loadConfig({ logger: libLogger });
  const conversation = await import("../conversation.js");
  const compaction = await import("../compaction.js");

  return {
    resolveConversation: conversation.resolveConversation,
    makeCompactionHandler: compaction.makeCompactionHandler,
    db: env.mod.getDb(),
    cleanup: env.cleanup,
  };
}

/** Inserts a conversation and returns its id. */
async function insertConversation(
  db: Harness["db"],
  overrides: {
    userId?: string;
    title?: string | null;
    summary?: string | null;
    throughMessageId?: number | null;
  } = {},
): Promise<number> {
  const row = await db
    .insertInto("conversations")
    .values({
      user_id: overrides.userId ?? "user-1",
      title: overrides.title ?? "A conversation",
      compacted_summary: overrides.summary ?? null,
      compacted_through_message_id: overrides.throughMessageId ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function insertMessage(
  db: Harness["db"],
  conversationId: number,
  role: string,
  content: string,
): Promise<number> {
  const row = await db
    .insertInto("messages")
    .values({ conversation_id: conversationId, role, content })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("makeCompactionHandler", () => {
  const update = {
    summary: "rolled up",
    throughMessageId: 4,
    changed: true,
  };

  it("persists the watermark into the conversation row", async () => {
    const env = await boot();
    try {
      const convId = await insertConversation(env.db);

      await env.makeCompactionHandler(convId)(update);

      const row = await env.db
        .selectFrom("conversations")
        .select(["compacted_summary", "compacted_through_message_id"])
        .where("id", "=", convId)
        .executeTakeFirstOrThrow();

      expect(row.compacted_summary).toBe("rolled up");
      expect(row.compacted_through_message_id).toBe(4);
    } finally {
      await env.cleanup();
    }
  });

  it("logs the persisted watermark", async () => {
    const env = await boot();
    try {
      const convId = await insertConversation(env.db);

      await env.makeCompactionHandler(convId)(update);

      expect(libLog.info).toHaveBeenCalledWith(
        { convId, throughMessageId: 4, saved: true },
        "Conversation compacted",
      );
    } finally {
      await env.cleanup();
    }
  });

  it("logs the not-persisted case without throwing", async () => {
    const env = await boot();
    try {
      // A conversation id that does not exist updates no rows, which is
      // `saved: false` rather than an error.
      await env.makeCompactionHandler(999_999)(update);

      expect(libLog.info).toHaveBeenCalledWith(
        { convId: 999_999, throughMessageId: 4, saved: false },
        "Compaction computed but watermark not persisted",
      );
      expect(libLog.error).not.toHaveBeenCalled();
    } finally {
      await env.cleanup();
    }
  });

  it("skips the write entirely when nothing changed", async () => {
    const env = await boot();
    try {
      const convId = await insertConversation(env.db, { summary: "old" });

      await env.makeCompactionHandler(convId)({
        summary: "ignored",
        throughMessageId: 9,
        changed: false,
      });

      const row = await env.db
        .selectFrom("conversations")
        .select("compacted_summary")
        .where("id", "=", convId)
        .executeTakeFirstOrThrow();

      expect(row.compacted_summary).toBe("old");
      expect(libLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ saved: true }) as unknown,
        "Conversation compacted",
      );
    } finally {
      await env.cleanup();
    }
  });

  it("does not fail the turn when the database is gone", async () => {
    const env = await boot();
    // Destroying the handle first makes every write reject, which is the same
    // shape as a dropped connection mid-request.
    await env.db.destroy();

    await expect(env.makeCompactionHandler(1)(update)).resolves.toBeUndefined();
    expect(libLog.error).toHaveBeenCalledTimes(1);
  });

  it("retries once before giving up", async () => {
    const env = await boot();
    await env.db.destroy();

    await env.makeCompactionHandler(1, { attempts: 2 })(update);

    // One warning on the first failure, one error on the last.
    expect(libLog.warn).toHaveBeenCalledTimes(1);
    expect(libLog.error).toHaveBeenCalledTimes(1);
  });

  it("honours a single attempt", async () => {
    const env = await boot();
    await env.db.destroy();

    await env.makeCompactionHandler(1, { attempts: 1 })(update);

    expect(libLog.warn).not.toHaveBeenCalled();
    expect(libLog.error).toHaveBeenCalledTimes(1);
  });
});

describe("createEventSink", () => {
  it("queues events until a consumer attaches", async () => {
    const { createEventSink } = await import("../eventSink.js");
    const sink = createEventSink();
    const seen: unknown[] = [];

    sink.push({ type: "chunk", text: "a" } as never);
    sink.push({ type: "chunk", text: "b" } as never);
    sink.attach((event) => seen.push(event));

    expect(seen).toEqual([
      { type: "chunk", text: "a" },
      { type: "chunk", text: "b" },
    ]);
  });

  it("delivers live once attached", async () => {
    const { createEventSink } = await import("../eventSink.js");
    const sink = createEventSink();
    const seen: unknown[] = [];
    sink.attach((event) => seen.push(event));

    sink.push({ type: "chunk", text: "a" } as never);

    expect(seen).toEqual([{ type: "chunk", text: "a" }]);
  });

  it("does not replay the queue twice when reattached", async () => {
    const { createEventSink } = await import("../eventSink.js");
    const sink = createEventSink();
    sink.push({ type: "chunk", text: "a" } as never);

    const first: unknown[] = [];
    sink.attach((event) => first.push(event));
    const second: unknown[] = [];
    sink.attach((event) => second.push(event));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("drops events pushed after detach instead of buffering them", async () => {
    const { createEventSink } = await import("../eventSink.js");
    const sink = createEventSink();
    const seen: unknown[] = [];
    sink.attach((event) => seen.push(event));
    sink.detach();

    sink.push({ type: "chunk", text: "a" } as never);
    expect(seen).toHaveLength(0);
  });

  it("does not deliver a queued event after it was detached", async () => {
    // A sink detached before anyone attached must stay silent, otherwise a
    // cancelled request would still stream into the response.
    const { createEventSink } = await import("../eventSink.js");
    const sink = createEventSink();
    sink.push({ type: "chunk", text: "a" } as never);
    sink.detach();

    const seen: unknown[] = [];
    sink.attach((event) => seen.push(event));
    expect(seen).toHaveLength(0);
  });

  it("routes a queued event to the most recent consumer after a reattach", async () => {
    const { createEventSink } = await import("../eventSink.js");
    const sink = createEventSink();
    const first: unknown[] = [];
    sink.attach((event) => first.push(event));

    const second: unknown[] = [];
    sink.attach((event) => second.push(event));
    sink.push({ type: "chunk", text: "later" } as never);

    expect(first).toHaveLength(0);
    expect(second).toEqual([{ type: "chunk", text: "later" }]);
  });
});

describe("createRequestAbort", () => {
  it("aborts the signal when the client disconnects", async () => {
    const env = await boot();
    try {
      const { createRequestAbort } = await import("../requestAbort.js");
      let disconnect: (() => void) | undefined;

      const abort = createRequestAbort({
        meta: { convId: 3 },
        onDisconnect: (cancel) => {
          disconnect = cancel;
        },
      });

      expect(abort.signal.aborted).toBe(false);
      disconnect?.();

      expect(abort.signal.aborted).toBe(true);
      expect(libLog.warn).toHaveBeenCalledWith(
        { convId: 3 },
        "Client disconnected during stream",
      );
    } finally {
      await env.cleanup();
    }
  });

  it("does not abort or warn after the request already finished", async () => {
    const env = await boot();
    try {
      const { createRequestAbort } = await import("../requestAbort.js");
      let disconnect: (() => void) | undefined;

      const abort = createRequestAbort({
        meta: { convId: 3 },
        onDisconnect: (cancel) => {
          disconnect = cancel;
        },
      });

      abort.markFinished();
      disconnect?.();

      // A normal close fires after the response completes; treating that as a
      // disconnect would abort a run that actually succeeded.
      expect(abort.signal.aborted).toBe(false);
      expect(libLog.warn).not.toHaveBeenCalled();
    } finally {
      await env.cleanup();
    }
  });

  it("aborts on repeated disconnects without warning twice", async () => {
    const env = await boot();
    try {
      const { createRequestAbort } = await import("../requestAbort.js");
      let disconnect: (() => void) | undefined;

      const abort = createRequestAbort({
        meta: { convId: 3 },
        onDisconnect: (cancel) => {
          disconnect = cancel;
        },
      });

      disconnect?.();
      disconnect?.();

      expect(abort.signal.aborted).toBe(true);
      // The guard is `finished`, not "already aborted", so the second close
      // still logs. What must not happen is a throw.
      expect(libLog.warn).toHaveBeenCalledTimes(2);
    } finally {
      await env.cleanup();
    }
  });

  it("exposes a manual abort", async () => {
    const env = await boot();
    try {
      const { createRequestAbort } = await import("../requestAbort.js");
      const abort = createRequestAbort({});
      abort.abort();
      expect(abort.signal.aborted).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it("works with no disconnect hook at all", async () => {
    const env = await boot();
    try {
      const { createRequestAbort } = await import("../requestAbort.js");
      const abort = createRequestAbort();
      expect(abort.signal.aborted).toBe(false);
      abort.markFinished();
      abort.abort();
      expect(abort.signal.aborted).toBe(true);
    } finally {
      await env.cleanup();
    }
  });
});

describe("resolveConversation", () => {
  it("loads an existing conversation's history in id order", async () => {
    const env = await boot();
    try {
      const convId = await insertConversation(env.db);
      await insertMessage(env.db, convId, "user", "first");
      await insertMessage(env.db, convId, "assistant", "second");
      await insertMessage(env.db, convId, "tool", "ignored");

      const result = await env.resolveConversation("user-1", convId, "hi");

      expect(result).toMatchObject({ ok: true, id: convId });
      if (!result.ok) throw new Error("expected ok");
      // Only user/assistant turns are replayed, and in insertion order.
      expect(result.history.map((entry) => entry.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(result.history.map((entry) => entry.message)).toEqual([
        "first",
        "second",
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it("returns the stored compaction state", async () => {
    const env = await boot();
    try {
      const convId = await insertConversation(env.db, {
        summary: "earlier summary",
        throughMessageId: 3,
      });

      const result = await env.resolveConversation("user-1", convId, "hi");

      if (!result.ok) throw new Error("expected ok");
      expect(result.compaction).toEqual({
        summary: "earlier summary",
        throughMessageId: 3,
      });
    } finally {
      await env.cleanup();
    }
  });

  it("reports a missing compaction state as empty rather than undefined", async () => {
    const env = await boot();
    try {
      const convId = await insertConversation(env.db);

      const result = await env.resolveConversation("user-1", convId, "hi");

      if (!result.ok) throw new Error("expected ok");
      expect(result.compaction).toEqual({
        summary: null,
        throughMessageId: null,
      });
    } finally {
      await env.cleanup();
    }
  });

  it("creates a new conversation when no id is given", async () => {
    const env = await boot();
    try {
      const result = await env.resolveConversation(
        "user-1",
        undefined,
        "A brand new question",
      );

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error("expected ok");
      expect(result.history).toEqual([]);
      expect(result.compaction).toEqual({
        summary: null,
        throughMessageId: null,
      });

      const row = await env.db
        .selectFrom("conversations")
        .select(["user_id", "title"])
        .where("id", "=", result.id)
        .executeTakeFirstOrThrow();
      expect(row.user_id).toBe("user-1");
      expect(row.title).toBe("A brand new question...");
    } finally {
      await env.cleanup();
    }
  });

  it("truncates a long first message into the title", async () => {
    const env = await boot();
    try {
      const long = "x".repeat(120);

      const result = await env.resolveConversation("user-1", undefined, long);
      if (!result.ok) throw new Error("expected ok");

      const row = await env.db
        .selectFrom("conversations")
        .select("title")
        .where("id", "=", result.id)
        .executeTakeFirstOrThrow();
      expect(row.title).toBe(`${"x".repeat(50)}...`);
    } finally {
      await env.cleanup();
    }
  });

  it("refuses a conversation owned by another user", async () => {
    const env = await boot();
    try {
      const convId = await insertConversation(env.db, { userId: "owner" });

      // The loader scopes by user, so a leaked id must not disclose history.
      await expect(
        env.resolveConversation("intruder", convId, "hi"),
      ).resolves.toEqual({
        ok: false,
        reason: "Conversation not found",
      });
    } finally {
      await env.cleanup();
    }
  });

  it("reports a missing conversation id", async () => {
    const env = await boot();
    try {
      await expect(
        env.resolveConversation("user-1", 424_242, "hi"),
      ).resolves.toEqual({
        ok: false,
        reason: "Conversation not found",
      });
    } finally {
      await env.cleanup();
    }
  });
});

describe("parseFiles", () => {
  /** A `File`-shaped object; jsdom's File is not available under `node`. */
  function file(name: string, type: string, bytes: Buffer) {
    return {
      name,
      type,
      size: bytes.length,
      arrayBuffer: () => Promise.resolve(bytes),
      text: () => Promise.resolve(bytes.toString("utf8")),
    } as unknown as File;
  }

  /** A file whose bytes are its own UTF-8 text. */
  function textFile(name: string, type: string, body: string): File {
    return file(name, type, Buffer.from(body));
  }

  it("passes the message through when there are no files", async () => {
    const { parseFiles } = await import("../attachments.js");

    await expect(parseFiles(undefined, "hello")).resolves.toEqual({
      hasFiles: false,
      message: "hello",
    });
  });

  it("passes the message through for an empty file list", async () => {
    const { parseFiles } = await import("../attachments.js");

    await expect(parseFiles([], "hello")).resolves.toEqual({
      hasFiles: false,
      message: "hello",
    });
  });

  it("extracts a real pdf through the real parser", async () => {
    const { parseFiles } = await import("../attachments.js");
    const pdf = await makePdf(["Page one body", "Page two body"]);

    const result = await parseFiles(
      [file("a.pdf", "application/pdf", pdf)],
      "summarise",
    );

    expect(result.hasFiles).toBe(true);
    expect(result.message).toContain("Page one body");
    expect(result.message).toContain("--- START FILE: a.pdf ---");
  });

  it("caps the pages read from a pdf", async () => {
    const { parseFiles } = await import("../attachments.js");
    // Five pages is the default cap; the sixth must not appear.
    const pdf = await makePdf(["P1", "P2", "P3", "P4", "P5", "P6"]);

    const result = await parseFiles(
      [file("a.pdf", "application/pdf", pdf)],
      "x",
    );

    expect(result.message).toContain("P5");
    expect(result.message).not.toContain("P6");
  });

  it("reads a csv through the real spreadsheet reader", async () => {
    const { parseFiles } = await import("../attachments.js");

    const result = await parseFiles(
      [textFile("a.csv", "text/csv", "name,age\nalice,30\n")],
      "summarise",
    );

    expect(result.hasFiles).toBe(true);
    expect(result.message).toContain("alice");
    expect(result.message).toContain("--- START FILE: a.csv ---");
  });

  it("falls back to raw text for other mime types", async () => {
    const { parseFiles } = await import("../attachments.js");

    const result = await parseFiles(
      [textFile("a.txt", "text/plain", "plain body")],
      "x",
    );

    expect(result.message).toContain("plain body");
  });

  it("fences every file and keeps the user message last", async () => {
    const { parseFiles } = await import("../attachments.js");
    const pdf = await makePdf(["pdf body"]);

    const result = await parseFiles(
      [
        file("a.pdf", "application/pdf", pdf),
        textFile("b.csv", "text/csv", "col\nvalue\n"),
      ],
      "what changed?",
    );

    expect(result.message).toContain("--- START FILE: a.pdf ---");
    expect(result.message).toContain("--- END FILE ---");
    expect(result.message).toContain("--- START FILE: b.csv ---");
    expect(result.message).toContain("[USER MESSAGE]\nwhat changed?");
    // The user's instruction must not be swallowed by the file bodies.
    expect(result.message.endsWith("what changed?")).toBe(true);
  });

  it("rejects more files than the cap", async () => {
    const { parseFiles } = await import("../attachments.js");

    await expect(
      parseFiles(
        [
          textFile("a.txt", "text/plain", "a"),
          textFile("b.txt", "text/plain", "b"),
          textFile("c.txt", "text/plain", "c"),
          textFile("d.txt", "text/plain", "d"),
        ],
        "x",
      ),
    ).rejects.toThrow("At most 3 files can be attached");
  });

  it("honours a custom file cap", async () => {
    const { parseFiles } = await import("../attachments.js");

    await expect(
      parseFiles(
        [
          textFile("a.txt", "text/plain", "a"),
          textFile("b.txt", "text/plain", "b"),
        ],
        "x",
        { maxFiles: 1 },
      ),
    ).rejects.toThrow("At most 1 files can be attached");
  });

  it("rejects a file over the byte cap", async () => {
    const { parseFiles } = await import("../attachments.js");

    const big = textFile("a.txt", "text/plain", "x".repeat(5_000));
    await expect(parseFiles([big], "x", { maxBytes: 1_000 })).rejects.toThrow(
      '"a.txt" is larger than 1000 bytes',
    );
  });

  it("rejects an unsupported mime type", async () => {
    const { parseFiles } = await import("../attachments.js");

    await expect(
      parseFiles(
        [textFile("a.bin", "application/octet-stream", "binary")],
        "x",
      ),
    ).rejects.toThrow(
      '"a.bin" has an unsupported type: application/octet-stream',
    );
  });

  it("propagates a parser failure", async () => {
    const { parseFiles } = await import("../attachments.js");

    await expect(
      // Not a PDF at all, so the real parser throws.
      parseFiles([textFile("a.pdf", "application/pdf", "not a pdf")], "x"),
    ).rejects.toThrow();
  });
});

/**
 * Builds a real multi-page PDF so the PDF path is exercised by the actual
 * parser rather than a stub.
 */
async function makePdf(pages: string[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([300, 200]);
    page.drawText(text, { x: 20, y: 160, size: 14, font });
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}
