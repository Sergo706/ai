import type { Selectable } from "kysely";
import type { MessageTrace, RunKind, RunStatus, RunsTable } from "../db/schema";

/** A row of the `runs` table, as read back from the database. */
export type StoredRun = Selectable<RunsTable>;

/** Partial output a run keeps while it is still in flight. */
export interface RunPartial {
  /** Assistant text so far. */
  text?: string;
  /** Reasoning rounds and tool steps collected so far. */
  trace?: MessageTrace;
  /** Final payload for a workflow run. */
  report?: unknown;
  /** Whether the run already had enough evidence when it was saved. */
  isSufficient?: boolean;
  /** Intents the run never got to. */
  missingIntents?: string[];
}

/** Input payload stored on a run row, so a resume can replay the request. */
export interface RunInput {
  /** Discriminator within `kind: "workflow"`; absent on chat rows. */
  name?: string;
  /** Locale hint carried over to the resumed run. */
  locale?: string;
  /** Timezone hint carried over to the resumed run. */
  timezone?: string;
  /** Anything else the workflow needs to rebuild its state. */
  [key: string]: unknown;
}

/** Arguments for {@link createRun}. */
export interface CreateRunArgs {
  /** Caller-supplied run id. */
  id: string;
  /** Which resume strategy this run belongs to. */
  kind: RunKind;
  /** The question or task the run works on. */
  query: string;
  /** Owner of the run. */
  userId?: string | null;
  /** Conversation the run answers, for chat turns. */
  conversationId?: number | null;
  /** What a resume needs to replay the request. Absent on chat rows. */
  input?: RunInput | null;
}

/** Arguments for {@link updateRun}. Fields left `undefined` are not touched. */
export interface UpdateRunArgs {
  /** The run to patch. */
  id: string;
  /** New lifecycle state. */
  status?: RunStatus;
  /** Partial output to store. */
  partial?: RunPartial;
  /** Why the run stopped. */
  stopReason?: string | null;
  /** Failure message, when the run failed. */
  error?: string | null;
  /** Assistant message the run produced. */
  messageId?: number | null;
  /** Set `true` to stamp `finished_at` with the current time. */
  finished?: boolean;
  /** When set, the update only applies if this instance still owns the lease. */
  owner?: string;
}
