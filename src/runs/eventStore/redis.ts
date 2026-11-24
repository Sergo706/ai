import type Redis from "ioredis";
import type { StoredEvent } from "../../types/Chat";
import {
  BLOCK_MS,
  MAX_STREAM_LEN,
  REPLAY_BATCH,
  STREAM_TTL_SECONDS,
  streamKey,
  type EventPage,
} from "./shared";


function wakeChannel(runId: string): string {
  return `run:wakeup:${runId}`;
}

const WAKE_PREFIX = "run:wakeup:";
const waiters = new Map<string, Set<() => void>>();
let subscribing: Promise<void> | null = null;

function parseEntries(entries: [string, string[]][]): {
  ids: string[];
  events: StoredEvent[];
} {
  const ids: string[] = [];
  const events: StoredEvent[] = [];
  for (const [id, fields] of entries) {
    const index = fields.indexOf("event");
    if (index === -1) continue;
    const raw = fields[index + 1];
    if (typeof raw !== "string") continue;
    try {
      ids.push(id);
      events.push(JSON.parse(raw) as StoredEvent);
    } catch {}
  }
  return { ids, events };
}

/**
 * Append one event to a run's Redis stream.
 *
 * Also refreshes the stream's TTL and wakes every parked reader.
 *
 * @param redis - Client to write with.
 * @param runId - The run to append to.
 * @param id - The event id, assigned by the caller.
 * @param event - The event to store.
 */
export async function appendRedis(
  redis: Redis,
  runId: string,
  id: string,
  event: StoredEvent,
): Promise<void> {
  const key = streamKey(runId);
  const payload = JSON.stringify(event);

  const results = await redis
    .pipeline()
    .xadd(key, "MAXLEN", "~", String(MAX_STREAM_LEN), id, "event", payload)
    .expire(key, STREAM_TTL_SECONDS)
    .publish(wakeChannel(runId), id)
    .exec();

  const xaddError = results?.[0]?.[0];
  if (!xaddError) return;
  if (!xaddError.message.includes("equal or smaller")) throw xaddError;

  const minted = await redis.xadd(
    key,
    "MAXLEN",
    "~",
    String(MAX_STREAM_LEN),
    "*",
    "event",
    payload,
  );
  await redis.expire(key, STREAM_TTL_SECONDS);
  await redis.publish(wakeChannel(runId), String(minted));
}

/**
 * Read one bounded page of a run's stream, strictly after `afterId`.
 *
 * @param redis - Client to read with.
 * @param runId - The run to read.
 * @param afterId - Cursor to resume from; the entry itself is skipped.
 * @param count - Maximum events to return.
 * @returns The events plus the id to pass as `afterId` next time.
 */
export async function readRedisPage(
  redis: Redis,
  runId: string,
  afterId: string,
  count: number,
): Promise<EventPage> {
  const entries = (await redis.xrange(
    streamKey(runId),
    `(${afterId}`,
    "+",
    "COUNT",
    count,
  )) as [string, string[]][];

  const last = entries.at(-1);
  return {
    ...parseEntries(entries),
    lastId: last ? last[0] : afterId,
  };
}

/**
 * Wait for the next event on a run's stream, up to `BLOCK_MS`.
 *
 * @param redis - Client to read with.
 * @param runId - The run to follow.
 * @param afterId - Cursor to resume from.
 * @returns The new page, or `null` when nothing arrived before the timeout.
 */
export async function waitForRedisNext(
  redis: Redis,
  runId: string,
  afterId: string,
): Promise<EventPage | null> {
  await ensureWakeSubscriber(redis);

  // Checked before sleeping so an append that landed between the previous read
  // and this call is not missed.
  const immediate = await readRedisPage(redis, runId, afterId, REPLAY_BATCH);
  if (immediate.events.length > 0) return immediate;

  await new Promise<void>((resolve) => {
    let settled = false;
    const set = waiters.get(runId) ?? new Set<() => void>();

    const wake = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      set.delete(wake);
      if (set.size === 0 && waiters.get(runId) === set) waiters.delete(runId);
      resolve();
    };

    const timer = setTimeout(wake, BLOCK_MS);
    (timer as { unref?: () => void }).unref?.();

    set.add(wake);
    waiters.set(runId, set);
  });

  const page = await readRedisPage(redis, runId, afterId, REPLAY_BATCH);
  return page.events.length === 0 ? null : page;
}

function ensureWakeSubscriber(redis: Redis): Promise<void> {
  if (subscribing) return subscribing;

  subscribing = new Promise<void>((resolve) => {
    let sub: Redis;
    try {
      sub = redis.duplicate();
    } catch {
      resolve();
      return;
    }

    sub.on("pmessage", (_pattern: string, channel: string) => {
      const set = waiters.get(channel.slice(WAKE_PREFIX.length));
      if (!set) return;
      for (const wake of [...set]) wake();
    });

    sub.on("error", () => {
      return;
    });

    sub.on("connect", () => {
      (sub as unknown as { stream?: { unref?: () => void } }).stream?.unref?.();
    });

    void sub
      .psubscribe(`${WAKE_PREFIX}*`)
      .then(() => {
        resolve();
      })
      .catch(() => {
        resolve();
      });
  });
  return subscribing;
}

/**
 * The id of the newest entry in a run's stream.
 *
 * @param redis - Client to read with.
 * @param runId - The run to inspect.
 * @returns The latest id, or `undefined` when the stream is empty.
 */
export async function lastRedisId(
  redis: Redis,
  runId: string,
): Promise<string | undefined> {
  const top = (await redis.xrevrange(
    streamKey(runId),
    "+",
    "-",
    "COUNT",
    1,
  )) as [string, string[]][];
  return top.at(0)?.[0];
}

/**
 * Restart the expiry clock on a run's stream.
 *
 * @param redis - Client to write with.
 * @param runId - The run to keep alive.
 */
export async function touchRedis(redis: Redis, runId: string): Promise<void> {
  await redis.expire(streamKey(runId), STREAM_TTL_SECONDS);
}

/**
 * Delete a run's stream.
 *
 * @param redis - Client to write with.
 * @param runId - The run to drop.
 */
export async function dropRedis(redis: Redis, runId: string): Promise<void> {
  await redis.del(streamKey(runId));
}
