import { AgentEvent } from "../types/ToolExecutionTypes";


export interface EventSink {
  push(event: AgentEvent): void;
  attach(consumer: (event: AgentEvent) => void): void;
  detach(): void;
}

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
