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
 * Appends one event under the id the caller assigned. `MAXLEN ~` lets Redis trim
 * approximately rather than exactly, which is far cheaper and irrelevant for a
 * capped stream.
 *
 * The id is explicit so the stream and the registry's in-memory log share one
 * cursor space: a client can replay from the handle, reconnect to another
 * replica, and pass the same id back. The run lease guarantees one writer per
 * run, which is what keeps the ids strictly increasing.
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
 * Reads one bounded page strictly after `afterId`.
 *
 * `COUNT` keeps a run that emitted tens of thousands of deltas from building a
 * single huge reply, and the returned `lastId` lets the caller continue. The
 * `(` prefix tells Redis the bound is exclusive, so the cursor entry itself is
 * not returned twice.
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
 * Waits until something is published for this run, or `BLOCK_MS` elapses.
 *
 * Nothing blocks on the command connection: the wait is a timer plus a pub/sub
 * wakeup, and the read that follows is a plain `XRANGE`. A stopped reader
 * therefore costs no socket and leaves no command parked in Redis.
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

/** The id of the newest entry in a run's stream, or `undefined` when empty. */
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

/** Refreshes the TTL while the run is working but silent. */
export async function touchRedis(redis: Redis, runId: string): Promise<void> {
  await redis.expire(streamKey(runId), STREAM_TTL_SECONDS);
}

/** Best-effort cleanup of a settled run's stream. */
export async function dropRedis(redis: Redis, runId: string): Promise<void> {
  await redis.del(streamKey(runId));
}
