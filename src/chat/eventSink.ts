import { AgentEvent } from "../types/ToolExecutionTypes";

/**
 * Buffers agent events until something is ready to consume them.
 *
 * `push` before `attach` queues instead of dropping, so a producer that starts
 * first loses nothing.
 *
 * @example
 * ```ts
 * const sink = createEventSink();
 * sink.attach((event) => send(frame(event)));
 * ```
 */
export interface EventSink {
  /** Record an event. Queued while nothing is attached, delivered otherwise. */
  push(event: AgentEvent): void;
  /** Take over delivery; replays anything already queued. */
  attach(consumer: (event: AgentEvent) => void): void;
  /** Stop delivering and drop the queue. */
  detach(): void;
}

/** Create an {@link EventSink} with an empty queue. */
export function createEventSink(): EventSink {
  const queue: AgentEvent[] = [];
  let state: "waiting" | "attached" | "detached" = "waiting";
  let consumer: ((event: AgentEvent) => void) | null = null;

  return {
    push(event) {
      if (state === "attached") consumer?.(event);
      else if (state === "waiting") queue.push(event);
    },
    attach(fn) {
      consumer = fn;
      state = "attached";
      for (const event of queue.splice(0)) fn(event);
    },
    detach() {
      consumer = null;
      state = "detached";
      queue.length = 0;
    },
  };
}
