import type { ToolLoopClient } from "../types/ToolExecutionTypes";
import type { ModelRequestOptions } from "./types";

/**
 * Forwards transport defaults to every provider call.
 *
 * A `Proxy` keeps the real client underneath, so `chat.completions` stays the
 * instance the SDK built, its methods read private state that a composed copy
 * would not carry.
 */
export function withRequestOptions(
  client: ToolLoopClient,
  request: ModelRequestOptions | undefined,
): ToolLoopClient {
  if (request === undefined) return client;

  type Completions = ToolLoopClient["chat"]["completions"];
  type Create = Completions["create"];

  const completions = new Proxy(client.chat.completions, {
    get(target, property, receiver) {
      if (property !== "create") {
        return Reflect.get(target, property, receiver) as unknown;
      }
      return (
        body: Parameters<Create>[0],
        options?: Parameters<Create>[1],
      ) => target.create(body, { ...request, ...options });
    },
  });

  const chat = new Proxy(client.chat, {
    get(target, property, receiver) {
      if (property === "completions") return completions;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  return { chat };
}
