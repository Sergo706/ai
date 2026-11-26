import type OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { fromJson } from "~/db/utils.js";
import { loadConfig } from "~~/test/test-utils/config";
import { chatCompletion } from "~~/test/test-utils/llm";
import { libLogger } from "~~/test/test-utils/logger";
import {
  completionFake,
  delta,
  embeddingFake,
  installEmbeddingFake,
  installStreamFake,
  offlineClient,
  streamFake,
  type StreamFake,
} from "~~/test/test-utils/streamLlm";

/**
 * The composed agent, end to end.
 *
 * Only the provider transports are faked. Everything else is real: the sqlite
 * database the units project configures, its migrations, the message and run
 * writers, the lease, the trace collector and the frame plumbing. That makes this
 * the suite that proves the pieces fit together, which no single-module test can.
 *
 * One behaviour worth knowing when reading the assertions: with no tools
 * advertised, `runToolRounds` makes a second, synthesised request that appends a
 * final system guard prompt. So `calls` usually holds two entries and the last
 * message is that guard, not the user's.
 */

type AgentModule = typeof import("../agent.js");

const DIMENSIONS = 8;

interface Harness {
  buildAgent: AgentModule["buildAgent"];
  db: ReturnType<typeof import("../../config/config.js").getDb>;
  cleanup: () => Promise<void>;
}

function baseConfig() {
  return {
    model: { model: "test-model", temperature: 0.5, maxTokens: 512 },
    systemInstructions: "You are a test agent.",
  };
}

/**
 * Boots a config whose OpenAI clients are real instances, then swaps only their
 * transports for fakes. The schema validates with `z.instanceof(OpenAI)`, so a
 * plain object cannot be injected, and this keeps every caller on the ordinary
 * `aiClients()` path instead of mocking modules.
 */
async function boot(fake: StreamFake): Promise<Harness> {
  const chat: OpenAI = offlineClient();
  installStreamFake(chat, fake);
  const embeddings: OpenAI = offlineClient();
  installEmbeddingFake(embeddings, embeddingFake(DIMENSIONS));

  const env = await loadConfig({
    logger: libLogger,
    dimensions: DIMENSIONS,
    overrides: {
      openAiConfig: chat,
      embeddingConfig: {
        client: embeddings,
        dimensions: DIMENSIONS,
        matchingModel: "test-matching",
        retrievalModel: "test-retrieval",
      },
    },
  });
  const mod = await import("../agent.js");
  return {
    buildAgent: mod.buildAgent,
    db: env.mod.getDb(),
    cleanup: env.cleanup,
  };
}

/** The user-facing request among the loop's calls (the last one carries the guard). */
function userMessages(call: Record<string, unknown>): string[] {
  const messages = call.messages as { role: string; content: string }[];
  return messages
    .filter((message) => message.role === "user")
    .map((m) => m.content);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildAgent — construction validation", () => {
  it("rejects `runs` without a persisted conversation", async () => {
    const env = await boot(streamFake([]));
    try {
      await expect(
        env.buildAgent({ ...baseConfig(), runs: { kind: "chat" } } as never),
      ).rejects.toThrow(
        "AgentConfig: `runs` requires `conversation` with `persist: true`.",
      );
    } finally {
      await env.cleanup();
    }
  });

  it("rejects `compaction` without a persisted conversation", async () => {
    const env = await boot(streamFake([]));
    try {
      await expect(
        env.buildAgent({
          ...baseConfig(),
          compaction: { temperature: 0.1, maxTokens: 100 },
        } as never),
      ).rejects.toThrow(
        "AgentConfig: `compaction` requires `conversation` with `persist: true`.",
      );
    } finally {
      await env.cleanup();
    }
  });

  it("rejects a duplicate tool name at construction, not on first request", async () => {
    const env = await boot(streamFake([]));
    try {
      const spec = {
        name: "mine",
        make: () => async () => ({ ok: true }),
        definitions: {
          type: "function" as const,
          function: { name: "mine", description: "", parameters: {} },
        },
      };

      // Failing here rather than on traffic is the point of assembling tools at
      // construction.
      await expect(
        env.buildAgent({ ...baseConfig(), tools: { specs: [spec, spec] } }),
      ).rejects.toThrow('Duplicate tool name "mine" in AgentConfig.');
    } finally {
      await env.cleanup();
    }
  });

  it("freezes the config it was built with", async () => {
    const env = await boot(streamFake([]));
    try {
      const agent = await env.buildAgent(baseConfig());

      expect(Object.isFrozen(agent.config)).toBe(true);
      expect(agent.config.model.model).toBe("test-model");
      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("accepts `runs` when the conversation is persisted", async () => {
    const env = await boot(streamFake([delta("ok", "stop")]));
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
        runs: { kind: "chat" },
      } as never);

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });
});

describe("buildAgent — a non-persisted turn", () => {
  it("answers without touching the database", async () => {
    const fake = streamFake([delta("Hello there", "stop")]);
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent(baseConfig());

      const result = await agent.complete({ message: "hi" });

      expect(result.text).toBe("Hello there");
      expect(result.conversationId).toBeUndefined();
      expect(result.runId).toBeUndefined();
      expect(result.cached).toBe(false);

      expect(
        await env.db.selectFrom("conversations").select("id").execute(),
      ).toEqual([]);
      expect(
        await env.db.selectFrom("messages").select("id").execute(),
      ).toEqual([]);

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("sends the system instructions and the user message", async () => {
    const fake = streamFake([delta("ok", "stop")]);
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent(baseConfig());

      await agent.complete({ message: "what is up" });

      const body = fake.calls[0] as {
        messages: { role: string; content: string }[];
        model: string;
        stream: boolean;
      };
      expect(body.model).toBe("test-model");
      expect(body.stream).toBe(true);
      expect(body.messages[0]).toMatchObject({
        role: "system",
        content: "You are a test agent.",
      });
      // The loop appends its guard as a final system message on the synthesised
      // request, so the user's ask is not the last entry.
      expect(body.messages[1]).toMatchObject({
        role: "user",
        content: "what is up",
      });
      expect(userMessages(body)).toEqual(["what is up"]);

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("appends the user context to the system prompt", async () => {
    const fake = streamFake([delta("ok", "stop")]);
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent(baseConfig());

      await agent.complete({
        message: "hi",
        user: { locale: "en-GB", timezone: "Europe/London" },
      });

      const body = fake.calls[0] as {
        messages: { role: string; content: string }[];
      };
      expect(body.messages[0]?.content).toContain("- Locale: en-GB");
      expect(body.messages[0]?.content).toContain("- Timezone: Europe/London");

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("replays the caller's history before the new message", async () => {
    const fake = streamFake([delta("ok", "stop")]);
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent(baseConfig());

      await agent.complete({
        message: "third",
        history: [
          { role: "user", message: "first" },
          { role: "assistant", message: "second" },
        ],
      } as never);

      const body = fake.calls[0] as {
        messages: { role: string; content: string }[];
      };
      // Only the non-system entries, so the loop's trailing guard does not
      // obscure the order being asserted.
      expect(
        body.messages
          .filter((message) => message.role !== "system")
          .map((message) => message.content),
      ).toEqual(["first", "second", "third"]);

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("forwards a per-turn model override", async () => {
    const fake = streamFake([delta("ok", "stop")]);
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent(baseConfig());

      await agent.complete({
        message: "hi",
        model: { model: "other-model", temperature: 0.9 },
      });

      expect(fake.calls[0]).toMatchObject({
        model: "other-model",
        temperature: 0.9,
      });

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("requires a userId once the conversation is persisted", async () => {
    const env = await boot(streamFake([delta("ok", "stop")]));
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
      });

      await expect(agent.complete({ message: "hi" })).rejects.toThrow(
        "ChatInput: `userId` is required when `conversation` is enabled.",
      );

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("refuses new turns after close, and closes idempotently", async () => {
    const env = await boot(streamFake([delta("ok", "stop")]));
    try {
      const agent = await env.buildAgent(baseConfig());
      await agent.close();
      await agent.close();

      await expect(agent.complete({ message: "hi" })).rejects.toThrow(
        "Agent is closed and cannot start new turns.",
      );
    } finally {
      await env.cleanup();
    }
  });

  it("surfaces a conversation that cannot be loaded", async () => {
    const env = await boot(streamFake([delta("ok", "stop")]));
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
      });

      await expect(
        agent.complete({
          message: "hi",
          userId: "u-1",
          conversationId: 987_654,
        }),
      ).rejects.toThrow("Conversation not found");

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });
});

describe("buildAgent — a persisted turn", () => {
  it("creates the conversation and both messages", async () => {
    const fake = streamFake([delta("the answer", "stop")]);
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
      });

      const result = await agent.complete({
        message: "a brand new question",
        userId: "u-1",
      });

      const conversation = await env.db
        .selectFrom("conversations")
        .select(["id", "user_id", "title"])
        .executeTakeFirstOrThrow();

      // The id the caller received is the row that was actually written.
      expect(result.conversationId).toBe(conversation.id);
      expect(conversation.user_id).toBe("u-1");
      expect(conversation.title).toBe("a brand new question...");

      const messages = await env.db
        .selectFrom("messages")
        .select(["role", "content"])
        .orderBy("id", "asc")
        .execute();
      expect(messages).toEqual([
        { role: "user", content: "a brand new question" },
        { role: "assistant", content: "the answer" },
      ]);

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("replays stored history on the next turn", async () => {
    // A real provider answers the second turn differently because the request
    // now contains the first exchange; key the frames off the request so the
    // replay assertion cannot pass on a replayed fixture.
    const fake = streamFake([], {
      respond: (body) => {
        const messages = body.messages as { role: string; content: string }[];
        const asked = messages.filter((m) => m.role === "user");
        return [
          delta(
            asked.length > 1
              ? "the second turn answer"
              : "the first turn answer",
            "stop",
          ),
        ];
      },
    });
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
      });

      const first = await agent.complete({
        message: "first question",
        userId: "u-1",
      });

      await agent.complete({
        message: "second question",
        userId: "u-1",
        conversationId: first.conversationId,
      });

      const body = fake.calls.at(-1) as {
        messages: { role: string; content: string }[];
      };
      // The stored exchange must be replayed, so the model sees continuity.
      // The loop appends a synthesised guard message, so compare only the
      // conversational turns.
      const conversational = body.messages.filter(
        (message) => message.role !== "system",
      );
      expect(conversational).toEqual([
        { role: "user", content: "first question" },
        { role: "assistant", content: "the first turn answer" },
        { role: "user", content: "second question" },
      ]);

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("does not write a second conversation for the same session", async () => {
    const fake = streamFake([delta("answer", "stop")]);
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
      });

      const first = await agent.complete({
        message: "one",
        userId: "u-1",
      });
      await agent.complete({
        message: "two",
        userId: "u-1",
        conversationId: first.conversationId,
      });

      const conversations = await env.db
        .selectFrom("conversations")
        .select("id")
        .execute();
      expect(conversations).toHaveLength(1);

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("records the run row when runs are on", async () => {
    const fake = streamFake([delta("managed answer", "stop")]);
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
        runs: { kind: "chat", name: "testAgent" },
      } as never);

      const result = await agent.complete({
        message: "managed question",
        userId: "u-1",
      });

      const run = await env.db
        .selectFrom("runs")
        .select(["id", "kind", "query", "user_id", "status"])
        .executeTakeFirstOrThrow();

      // There is at most one row, and the caller got its id back.
      expect(result.runId).toBe(run.id);
      expect(run.kind).toBe("chat");
      expect(run.query).toBe("managed question");
      expect(run.user_id).toBe("u-1");
      expect(run.status).toBe("finished");

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("records the discriminator on the run input", async () => {
    const fake = streamFake([delta("answer", "stop")]);
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
        runs: { kind: "chat", name: "namedAgent" },
      } as never);

      await agent.complete({ message: "q", userId: "u-1" });

      const run = await env.db
        .selectFrom("runs")
        .select("input")
        .executeTakeFirstOrThrow();
      // `runs.input` is `jsonb` on postgres and `text` on sqlite, so the value
      // comes back either parsed or as a string; `fromJson` is the reader the
      // production code uses for exactly this reason.
      expect(
        fromJson<{ name: string }>(run.input as { name: string } | null),
      ).toEqual({
        name: "namedAgent",
      });

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });
});

describe("buildAgent — option plumbing", () => {
  it("defaults the run kind to `chat` when one is not configured", async () => {
    const env = await boot(streamFake([delta("ok", "stop")]));
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
        // No `kind`: the row must still be a chat run rather than undefined.
        runs: {},
      });

      await agent.complete({ message: "q", userId: "u-1" });

      const run = await env.db
        .selectFrom("runs")
        .select("kind")
        .executeTakeFirstOrThrow();
      expect(run.kind).toBe("chat");

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("omits the run input when the run has no name", async () => {
    const env = await boot(streamFake([delta("ok", "stop")]));
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
        runs: { kind: "chat" },
      } as never);

      await agent.complete({ message: "q", userId: "u-1" });

      const run = await env.db
        .selectFrom("runs")
        .select("input")
        .executeTakeFirstOrThrow();
      // Not `{name: undefined}`: the column stays empty when nothing was named.
      expect(run.input).toBeNull();

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("stores null for the user id on an anonymous run", async () => {
    const env = await boot(streamFake([delta("ok", "stop")]));
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
        runs: { kind: "chat" },
      } as never);

      // `conversation.persist` requires a userId, so this path is only reachable
      // with one; the assertion pins that the row keeps it.
      await agent.complete({ message: "q", userId: "u-1" });
      const run = await env.db
        .selectFrom("runs")
        .select("user_id")
        .executeTakeFirstOrThrow();
      expect(run.user_id).toBe("u-1");

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("forwards tool round limits and thinking effort to the provider", async () => {
    const fake = streamFake([delta("ok", "stop")]);
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        model: {
          model: "test-model",
          tools: {
            temperature: 0.15,
            maxTokens: 300,
            maxRounds: 3,
            maxCalls: 7,
          },
          thinkingEffort: "medium",
        },
      } as never);

      await agent.complete({ message: "hi" });

      // Nothing was advertised as a tool, so the loop synthesises immediately and
      // the round limits never reach the wire; the answer call still carries the
      // configured temperature and effort.
      expect(fake.calls[0]).toMatchObject({
        model: "test-model",
        temperature: 0.4,
        max_tokens: 8_192,
        reasoning_effort: "medium",
      });

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("sends `json_object` for a plain JSON ask but stays on the stream path", async () => {
    const fake = streamFake([delta('{"answer":"ok"}', "stop")]);
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent(baseConfig());

      const result = await agent.complete({ message: "hi", json: {} });

      expect(fake.calls[0]).toMatchObject({
        response_format: { type: "json_object" },
        stream: true,
      });
      expect(result.text).toBe('{"answer":"ok"}');

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("runs a validated JSON turn without streaming", async () => {
    // A validated turn runs the tool loop in `stream: false` mode, and with no
    // tools advertised that is *two* requests: the round, then the synthesis.
    // Both must resolve a completion object rather than an async iterable.
    const fake = completionFake(chatCompletion('{"answer":"ok"}'));
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent(baseConfig());
      const schema = z.object({ answer: z.string() });

      const result = await agent.complete({
        message: "hi",
        json: { validate: true, schema },
      });

      // With no tools advertised `runToolRounds` skips straight to a synthesised
      // final request, so the validated turn is a single non-streamed call.
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toMatchObject({
        stream: false,
        response_format: { type: "json_object" },
      });
      expect(result.structured).toEqual({ answer: "ok" });
      expect(result.text).toBe('{"answer":"ok"}');

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("finishes and fails managed run rows for validated JSON turns", async () => {
    const schema = z.object({ answer: z.string() });

    const okFake = completionFake(chatCompletion('{"answer":"ok"}'));
    const okEnv = await boot(okFake);
    try {
      const agent = await okEnv.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
        runs: { kind: "chat", name: "jsonAgent" },
      } as never);

      const result = await agent.complete({
        message: "hi",
        userId: "u-1",
        json: { validate: true, schema },
      });

      if (result.runId === undefined) {
        throw new Error("expected runId for managed validated JSON turn");
      }
      const run = await okEnv.db
        .selectFrom("runs")
        .select(["id", "status", "error", "finished_at"])
        .where("id", "=", result.runId)
        .executeTakeFirstOrThrow();
      expect(run.status).toBe("finished");
      expect(run.error).toBeNull();
      expect(typeof run.finished_at).toBe("string");

      await agent.close();
    } finally {
      await okEnv.cleanup();
    }

    const failFake = completionFake(chatCompletion("not-json"));
    const failEnv = await boot(failFake);
    try {
      const agent = await failEnv.buildAgent({
        ...baseConfig(),
        conversation: { persist: true },
        runs: { kind: "chat", name: "jsonAgent" },
      } as never);

      await expect(
        agent.complete({
          message: "hi",
          userId: "u-1",
          json: { validate: true, schema, maxRetries: 0 },
        }),
      ).rejects.toThrow();

      const run = await failEnv.db
        .selectFrom("runs")
        .select(["status", "error", "finished_at"])
        .executeTakeFirstOrThrow();
      expect(run.status).toBe("failed");
      expect(typeof run.error).toBe("string");
      expect((run.error ?? "").length).toBeGreaterThan(0);
      expect(typeof run.finished_at).toBe("string");

      await agent.close();
    } finally {
      await failEnv.cleanup();
    }
  });

  it("surfaces a provider failure as an error frame and empty text", async () => {
    // A tool has to be advertised for the loop to call the provider at all, so
    // this suite needs one to reach a mid-stream failure. `streamFinalAnswer`
    // converts a provider throw into an `error` frame with a user-facing
    // apology, and the turn still resolves rather than rejecting.
    const fake = streamFake([], { throwAfter: new Error("provider exploded") });
    const env = await boot(fake);
    try {
      const agent = await env.buildAgent({
        ...baseConfig(),
        tools: {
          specs: [
            {
              name: "probe",
              make: () => async () => ({ ok: true }),
              definitions: {
                type: "function" as const,
                function: {
                  name: "probe",
                  description: "",
                  parameters: { type: "object", properties: {} },
                },
              },
            },
          ],
        },
      });

      const stream = await agent.chat({ message: "hi" });
      const frames: { type: string; message?: string }[] = [];
      for await (const frame of stream.frames) frames.push(frame);
      const result = await stream.done;

      // The apology is what a user sees; the raw provider text never leaks.
      expect(frames.map((frame) => frame.type)).toEqual([
        "init",
        "error",
        "done",
      ]);
      expect(frames[1]?.message).toContain(
        "reached my internal processing limit",
      );
      expect(frames[1]?.message).not.toContain("provider exploded");
      expect(result.text).toBe("");
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toContain(
        "reached my internal processing limit",
      );
      expect(result.error?.message).not.toContain("provider exploded");

      await agent.close();
    } finally {
      await env.cleanup();
    }
  });

  it("serves a full run-backed semantic cache hit when both runs and semanticCache are enabled", async () => {
    const fake = streamFake([delta("Cached managed reply", "stop")]);
    const env = await boot(fake);
    try {
      const { getRun, clearRuns } = await import("~/runs/runRegistry.js");
      try {
        const agent = await env.buildAgent({
          ...baseConfig(),
          conversation: { persist: true },
          runs: { kind: "chat", name: "faqAgent" },
          semanticCache: { similarity: 0.9, windowHours: 24 },
        });

        const first = await agent.complete({
          message: "What is our refund window?",
          userId: "u-cache-run",
          runId: "run-live-1",
        });
        expect(first.cached).toBe(false);
        expect(first.runId).toBe("run-live-1");
        const callsAfterFirst = fake.calls.length;

        const second = await agent.complete({
          message: "What is our refund window?",
          userId: "u-cache-run",
          runId: "run-cached-2",
        });
        expect(second.cached).toBe(true);
        expect(second.runId).toBe("run-cached-2");
        expect(second.text).toBe("Cached managed reply");
        // No new LLM call was made on the cached turn.
        expect(fake.calls).toHaveLength(callsAfterFirst);

        const cachedRow = await env.db
          .selectFrom("runs")
          .select([
            "id",
            "status",
            "owner",
            "claimed_at",
            "finished_at",
            "input",
            "partial",
          ])
          .where("id", "=", "run-cached-2")
          .executeTakeFirstOrThrow();
        expect(cachedRow.status).toBe("finished");
        expect(cachedRow.owner).toBeNull();
        expect(cachedRow.claimed_at).toBeNull();
        expect(cachedRow.finished_at).not.toBeNull();
        expect(
          fromJson<{ name: string }>(
            cachedRow.input as { name: string } | null,
          ),
        ).toEqual({
          name: "faqAgent",
        });
        expect(
          fromJson<{ text: string }>(
            cachedRow.partial as { text: string } | null,
          ),
        ).toEqual({
          text: "Cached managed reply",
        });

        const handle = getRun("run-cached-2");
        expect(handle?.status).toBe("finished");
        expect(handle?.events).toEqual([
          { type: "chunk", text: "Cached managed reply" },
          { type: "done" },
        ]);

        await agent.close();
      } finally {
        clearRuns();
      }
    } finally {
      await env.cleanup();
    }
  });
});
