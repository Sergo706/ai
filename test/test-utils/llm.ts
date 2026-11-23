import { vi } from "vitest";

/**
 * Fake OpenAI client.
 *
 * The agents reach the model through `client.chat.completions.create`. That
 * method is the transport boundary — the one thing that genuinely cannot run
 * offline — so it is what gets faked. Prompt construction, the zod round trip
 * and the `llmSchemaParser` retry loop all still execute for real.
 */

export interface CapturedChatCall {
  model?: string;
  messages: readonly { role: string; content?: unknown }[];
  response_format?: unknown;
  stream?: boolean;
  tools?: readonly unknown[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionLike {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      refusal: string | null;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** A well-formed completion whose single choice carries `content`. */
export function chatCompletion(
  content: string,
  overrides: Partial<{
    model: string;
    finishReason: string;
    refusal: string | null;
  }> = {},
): ChatCompletionLike {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_700_000_000,
    model: overrides.model ?? "deepseek-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          refusal: overrides.refusal ?? null,
        },
        finish_reason: overrides.finishReason ?? "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

/** A completion with no choices, which the parser must reject and retry. */
export function emptyCompletion(): ChatCompletionLike {
  return {
    id: "chatcmpl-empty",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "deepseek-flash",
    choices: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export interface FakeLlm {
  /** Pass this wherever the code expects an `OpenAI` client. */
  client: {
    chat: {
      completions: {
        create: (args: CapturedChatCall) => Promise<unknown>;
      };
    };
  };
  /** Every `create` call, in order, already unpacked. */
  calls: CapturedChatCall[];
  /** Queue the next response(s); unqueued calls repeat the last one. */
  queue: (...responses: unknown[]) => void;
  /** Fail the next call(s) with `error` instead of resolving. */
  failNext: (error: Error, times?: number) => void;
}

/**
 * Builds a client stub with a queue of canned responses.
 *
 * Responses are consumed in order; once the queue is down to one entry it is
 * replayed forever, so a test that does not care about call counts does not
 * have to know how many times the code retries.
 */
export function createFakeLlm(...initial: unknown[]): FakeLlm {
  const calls: CapturedChatCall[] = [];
  const responses = [...initial];
  const failures: { error: Error; remaining: number }[] = [];

  const create = vi.fn((args: CapturedChatCall): Promise<unknown> => {
    calls.push(args);

    const failure = failures.at(0);
    if (failure && failure.remaining > 0) {
      failure.remaining--;
      if (failure.remaining === 0) failures.shift();
      return Promise.reject(failure.error);
    }

    const next = responses.length > 1 ? responses.shift() : responses[0];
    return Promise.resolve(next);
  });

  return {
    client: { chat: { completions: { create } } },
    calls,
    queue: (...next: unknown[]) => {
      responses.push(...next);
    },
    failNext: (error: Error, times = 1) => {
      failures.push({ error, remaining: times });
    },
  };
}

/** The text of the first message with `role`, for asserting prompt content. */
export function messageContent(
  call: CapturedChatCall,
  role: "system" | "user" | "assistant",
): string {
  const message = call.messages.find((entry) => entry.role === role);
  if (!message) throw new Error(`No ${role} message in the captured call`);
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}

/**
 * The text of the **last** message in the call.
 *
 * A repair loop appends its correction to the end of the conversation, so the
 * first `user` message is the original question and the guidance the code just
 * built is last. `messageContent` cannot express that and would silently assert
 * against the wrong turn.
 */
export function lastMessage(call: CapturedChatCall): string {
  const message = call.messages.at(-1);
  if (!message) throw new Error("The captured call has no messages");
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}
