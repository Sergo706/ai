import type { Selectable } from "kysely";
import type { MessageTrace, RunKind, RunStatus, RunsTable } from "../db/schema";

/** A row of the `runs` table. */
export type StoredRun = Selectable<RunsTable>;

export interface RunPartial {
  text?: string;
  trace?: MessageTrace;
  report?: unknown;
  isSufficient?: boolean;
  missingIntents?: string[];
}

export interface RunInput {
  /** Discriminator within `kind: "workflow"`; absent on chat rows. */
  name?: string;
  locale?: string;
  timezone?: string;
  [key: string]: unknown;
}

export interface CreateRunArgs {
  id: string;
  kind: RunKind;
  query: string;
  userId?: string | null;
  conversationId?: number | null;
  /** What a resume needs to replay the request. Absent on chat rows. */
  input?: RunInput | null;
}

export interface UpdateRunArgs {
  id: string;
  status?: RunStatus;
  partial?: RunPartial;
  stopReason?: string | null;
  error?: string | null;
  messageId?: number | null;
  finished?: boolean;
}
