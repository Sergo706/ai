import { envInt } from "@riavzon/utils/server";
import { getConfiguration } from "../../config/config";
import type { StoredEvent } from "../../types/Chat";

const eventConfig = () => getConfiguration().runs.eventStore;

/**
 * How many events one stream keeps. Redis trims the oldest entries past this.
 *
 * The floor of 100 exists because a smaller cap can trim an entry a reader is
 * still replaying on a busy run. The cap is a safety valve, not a tuning target.
 */
export const MAX_STREAM_LEN = envInt(
  "RUNS_STREAM_MAX_LEN",
  eventConfig().maxStreamLen,
  { min: 100 },
);

/** How long a finished stream survives, so a late reader can still replay it. */
export const STREAM_TTL_SECONDS = envInt(
  "RUNS_STREAM_TTL_SECONDS",
  eventConfig().ttlSeconds,
  { min: 60 },
);

/**
 * How long one `XREAD BLOCK` waits before the caller re-checks for closure.
 *
 * The only one of the four with a ceiling. A block longer than the stream TTL
 * would let the key expire while the read is still parked, so the reader would
 * wake to a missing key instead of to its own timeout. Clamping keeps that from
 * becoming configurable.
 */
export const BLOCK_MS = Math.min(
  envInt("RUNS_STREAM_BLOCK_MS", eventConfig().blockMs, { min: 1_000 }),
  Math.max(1_000, Math.floor((STREAM_TTL_SECONDS * 1_000) / 2)),
);

/** Page size when replaying a stream that already holds thousands of entries. */
export const REPLAY_BATCH = envInt(
  "RUNS_STREAM_REPLAY_BATCH",
  eventConfig().replayBatch,
  { min: 1 },
);

/** A fresh cursor. Redis stream ids are `<ms>-<seq>`; `0-0` is the beginning. */
export const FIRST_ID = "0-0";

/**
 * The next stream id after `lastId`.
 *
 * The registry assigns ids rather than letting each backend mint its own, so a
 * client sees one cursor space whether it reattaches to the local handle or to
 * the cross-replica store. `Date.now()` alone is not enough — two events in the
 * same millisecond need distinct ids — so the second half is a counter that
 * resets whenever the clock advances.
 *
 * Ids must stay strictly increasing for `XADD` to accept them explicitly.
 */
export function nextId(lastId: string | undefined): string {
  const now = Date.now();
  if (!lastId) return `${String(now)}-0`;

  const [msRaw, seqRaw] = lastId.split("-");
  const previousMs = Number(msRaw);

  const ms = Math.max(now, previousMs);
  if (ms > previousMs) return `${String(ms)}-0`;

  return `${String(ms)}-${String(Number(seqRaw) + 1)}`;
}

/**
 * Orders two stream ids.
 *
 * Plain string comparison is wrong here — `"…-10"` sorts before `"…-3"` — so
 * both halves are compared numerically. `streamFromRun` uses this to find the
 * first local event a reconnecting client has not seen, which replaces the
 * array index that silently shifted once the log was trimmed.
 */
export function compareIds(a: string, b: string): number {
  const [aMs, aSeq] = a.split("-");
  const [bMs, bSeq] = b.split("-");

  const ms = Number(aMs) - Number(bMs);
  if (ms !== 0) return ms < 0 ? -1 : 1;

  const seq = Number(aSeq) - Number(bSeq);
  if (seq !== 0) return seq < 0 ? -1 : 1;

  return 0;
}

/**
 * The index of the first entry in `ids` that comes after `afterId`.
 *
 * This is what a local replay starts at, and why `streamFromRun` no longer
 * takes an array index: an index means "the 12th event this process still
 * holds", which shifts every time the log is trimmed, whereas an id means "the
 * event after this one" no matter what was dropped. A cursor the log no longer
 * contains starts at 0 — the eager equivalent of Redis replaying from the
 * oldest surviving entry — and a cursor past the end returns `ids.length`, so
 * a stale client gets no events rather than the wrong ones.
 */
export function firstIndexAfter(ids: string[], afterId: string): number {
  if (afterId === FIRST_ID) return 0;
  const index = ids.findIndex((id) => compareIds(id, afterId) > 0);
  return index === -1 ? ids.length : index;
}

export function streamKey(runId: string): string {
  return `run:${runId}:events`;
}

/** One bounded page of a run's log plus the cursor to continue from. */
export interface EventPage {
  /** The stream id of each entry in `events`, in the same order. */
  ids: string[];
  events: StoredEvent[];
  lastId: string;
}
