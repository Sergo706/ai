import type { SseFrame } from "../types/Chat";

/**
 * Push-to-pull bridge: the loop pushes as it works, the reader pulls.
 *
 * Unbounded on purpose. A reader that stops pulling must not stall the loop,
 * because with runs enabled the loop is what persists the answer.
 */
export class FrameQueue {
  private readonly buffer: SseFrame[] = [];
  private waiting: ((step: IteratorResult<SseFrame>) => void) | undefined;
  private closed = false;

  push(frame: SseFrame): void {
    if (this.closed) return;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting({ value: frame, done: false });
    } else {
      this.buffer.push(frame);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  frames(): AsyncIterable<SseFrame> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<SseFrame> => ({
        next: () => {
          const frame = this.buffer.shift();
          if (frame !== undefined) {
            return Promise.resolve({ value: frame, done: false });
          }
          if (this.closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            this.waiting = resolve;
          });
        },
        return: () => {
          this.close();
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
  }
}

/** A turn whose frames are already known, e.g. a cache hit or a JSON answer. */
export function framesOf(frames: readonly SseFrame[]): AsyncIterable<SseFrame> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<SseFrame> => {
      let index = 0;
      return {
        next: () => {
          if (index >= frames.length) {
            return Promise.resolve({
              value: undefined,
              done: true,
            }) as Promise<IteratorResult<SseFrame>>;
          }
          const frame = frames[index];
          index += 1;
          return Promise.resolve({ value: frame, done: false });
        },
      };
    },
  };
}
