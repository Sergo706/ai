import { envInt } from "@riavzon/utils/server";
import { getConfiguration } from "../../config/config";
import type { StoredEvent } from "../../types/Chat";

const eventConfig = () => getConfiguration().runs.eventStore;

/**
 * How many events one run's stream keeps. Older entries are trimmed.
 *
 * @default config.runs.eventStore.maxStreamLen
 */
export function getMaxStreamLen(): number {
  return envInt("RUNS_STREAM_MAX_LEN", eventConfig().maxStreamLen, {
    min: 100,
  });
}

/**
 * How long a finished stream survives, so a late reader can still replay it.
 *
 * @default config.runs.eventStore.ttlSeconds
 */
export function getStreamTtlSeconds(): number {
  return envInt("RUNS_STREAM_TTL_SECONDS", eventConfig().ttlSeconds, {
    min: 60,
  });
}

/**
 * How long one blocking read waits before the caller re-checks for closure.
 *
 * Clamped to half the stream TTL so a parked read cannot outlive the key.
 */
export function getBlockMs(): number {
  return Math.min(
    envInt("RUNS_STREAM_BLOCK_MS", eventConfig().blockMs, { min: 1_000 }),
    Math.max(1_000, Math.floor((getStreamTtlSeconds() * 1_000) / 2)),
  );
}

/** Page size when replaying a stream that already holds thousands of entries. */
export function getReplayBatch(): number {
  return envInt("RUNS_STREAM_REPLAY_BATCH", eventConfig().replayBatch, {
    min: 1,
  });
}

/** A fresh cursor. Redis stream ids are `<ms>-<seq>`; `0-0` is the beginning. */
export const FIRST_ID = "0-0";

/**
 * The next stream id after `lastId`.
 *
 * Ids are minted here so a client sees one cursor space whether it reattaches
 * to the local handle or to the shared store, and they stay strictly increasing
 * as `XADD` requires.
 *
 * @param lastId - The previous id, or `undefined` to start a stream.
 * @returns An id of the form `<ms>-<seq>`.
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
 * Order two stream ids numerically.
 *
 * @param a - First id.
 * @param b - Second id.
 * @returns Negative when `a` comes first, positive when `b` does, else `0`.
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
 * Index of the first entry in `ids` that comes after `afterId`.
 *
 * @param ids - The ids of the events still held.
 * @param afterId - The cursor the client last saw.
 * @returns The index to start replaying at; `ids.length` when the cursor is
 * past the end, and `0` when the log no longer contains it.
 */
export function firstIndexAfter(ids: string[], afterId: string): number {
  if (afterId === FIRST_ID) return 0;
  const index = ids.findIndex((id) => compareIds(id, afterId) > 0);
  return index === -1 ? ids.length : index;
}

/**
 * The store key holding one run's event stream.
 *
 * @param runId - The run id.
 */
export function streamKey(runId: string): string {
  return `run:${runId}:events`;
}

/** One bounded page of a run's log plus the cursor to continue from. */
export interface EventPage {
  /** The stream id of each entry in `events`, in the same order. */
  ids: string[];
  /** The events in this page, oldest first. */
  events: StoredEvent[];
  /** Cursor to request the next page from. */
  lastId: string;
}
