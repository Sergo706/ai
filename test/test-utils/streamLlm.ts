import OpenAI from "openai";
import { vi } from "vitest";

/**
 * Provider transport fakes.
 *
 * The streaming path consumes an async iterable of SSE deltas — a resolved
 * `ChatCompletion` object makes it throw `responseUnavailableError`. These
 * helpers build the shapes the loop reads, and the embedding helper answers at a
 * configured width so `generateEmbedding`'s dimension check passes offline.
 *
 * Only transports are faked; the first thing that genuinely cannot run offline
 * is the network itself.
 */

/** One SSE delta frame in the shape the loop reads. */
export function delta(
  content: string,
  finish: string | null = null,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    choices: [
      { index: 0, delta: { content, ...extra }, finish_reason: finish },
    ],
  };
}

/** A delta carrying only a finish marker, for a stream that emits no text. */
export function finishOnly(finish = "stop"): unknown {
  return { choices: [{ index: 0, delta: {}, finish_reason: finish }] };
}

export interface StreamFake {
  client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } };
  /** Every request body the loop sent, in order. */
  calls: Record<string, unknown>[];
}

export interface StreamFakeOptions {
  /** Thrown after the queued frames are consumed. */
  throwAfter?: Error;
  /** Thrown instead of returning a stream. */
  failImmediately?: Error;
  /**
   * Chooses the frames for a given request body, overriding `frames`.
   *
   * Multi-turn suites need the second turn to answer differently from the
   * first; keying off the request body is how a real provider behaves and keeps
   * the assertions honest about what was actually replayed.
   */
  respond?: (body: Record<string, unknown>) => readonly unknown[];
}

/**
 * A client whose `create` resolves to an async iterable of `frames`.
 *
 * By default every call replays the same frames. Note that the loop makes a
 * second, synthesised call when no tools are advertised, so the frames appear
 * twice unless the suite accounts for both requests — or supplies `respond`.
 */
export function streamFake(
  frames: readonly unknown[],
  options: StreamFakeOptions = {},
): StreamFake {
  const calls: Record<string, unknown>[] = [];

  const create = vi.fn((body: Record<string, unknown>) => {
    calls.push(body);
    if (options.failImmediately) {
      return Promise.reject(options.failImmediately);
    }
    const selected =
      options.respond === undefined ? frames : options.respond(body);
    async function* generate(): AsyncGenerator {
      for (const frame of selected) yield frame;
      if (options.throwAfter) throw options.throwAfter;
    }
    return Promise.resolve(generate());
  });

  return { client: { chat: { completions: { create } } }, calls };
}

/**
 * A client that **resolves** completion objects instead of streaming.
 *
 * `streamFake` always returns an async iterable because that is what the
 * streaming path consumes, so it cannot serve a `stream: false` caller: the
 * loop reads `completion.choices`, which an iterable does not have. A
 * non-streamed turn — `agent.json({ validate: true })`, or any
 * `completeFinalAnswer` request — needs this shape instead.
 *
 * Responses are consumed in order and the last one repeats, matching
 * `createFakeLlm`.
 */
export function completionFake(...responses: unknown[]): StreamFake {
  const calls: Record<string, unknown>[] = [];

  const create = vi.fn((body: Record<string, unknown>) => {
    calls.push(body);
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return Promise.resolve(next);
  });

  return { client: { chat: { completions: { create } } }, calls };
}

/**
 * Replaces the configured provider client's `chat.completions.create` with the
 * fake's.
 *
 * `src/config/config.ts` memoises the client it was given and the schema
 * validates it with `z.instanceof(OpenAI)`, so a plain object cannot be
 * injected. Swapping the transport on a real instance keeps every caller on the
 * ordinary `aiClients()` path — no module mocking, no re-plumbing.
 */
export function installStreamFake(client: OpenAI, fake: StreamFake): void {
  Object.assign(client.chat.completions, {
    create: fake.client.chat.completions.create,
  });
}

/**
 * Deterministic embedding vector of the requested width.
 *
 * `generateEmbedding` compares the returned length against
 * `embeddingConfig.dimensions` and throws otherwise, so the fixture has to match
 * whatever the suite configured rather than a constant.
 */
export function embeddingVector(text: string, dimensions: number): number[] {
  return Array.from({ length: dimensions }, (_, index) => {
    const seed = text.charCodeAt(index % Math.max(1, text.length)) || 1;
    return (seed % 17) / 17;
  });
}

export interface EmbeddingFake {
  client: { embeddings: { create: ReturnType<typeof vi.fn> } };
  /** Every input text the application embedded, in order. */
  inputs: string[];
}

/** A client whose `embeddings.create` answers offline at the given width. */
export function embeddingFake(dimensions: number): EmbeddingFake {
  const inputs: string[] = [];
  const create = vi.fn((body: { input: string; model: string }) => {
    inputs.push(body.input);
    return Promise.resolve({
      object: "list",
      model: body.model,
      data: [
        {
          object: "embedding",
          index: 0,
          embedding: embeddingVector(body.input, dimensions),
        },
      ],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  });
  return { client: { embeddings: { create } }, inputs };
}

/** Swaps the embeddings transport on a real client. */
export function installEmbeddingFake(
  client: OpenAI,
  fake: EmbeddingFake,
): void {
  Object.assign(client.embeddings, { create: fake.client.embeddings.create });
}

/** A real client pointing at an unroutable address, for config injection. */
export function offlineClient(): OpenAI {
  return new OpenAI({ apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" });
}
