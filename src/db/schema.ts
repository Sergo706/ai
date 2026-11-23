import type { ColumnType, Generated, JSONColumnType } from "kysely";
import type { Checkpoint } from "../types/Checkpoint";

export interface StoredToolStep {
  id: string;
  name: string;
  args: unknown;
  ok: boolean;
  durationMs: number;
  callIndex: number;
  callTotal: number;
  result: string;
  previewHidden: boolean;
}

export interface MessageTrace {
  reasoning: { round: number; text: string }[];
  steps: StoredToolStep[];
  workflow?: {
    title: string;
    runId?: string;
    custom?: Record<string, unknown>;
  }[];
}

export type RunStatus = "running" | "finished" | "aborted" | "failed" | "interrupted";

export interface RunKindRegistry {
  chat: true;
  workflow: true;
}
export type RunKind = keyof RunKindRegistry;

type TimestampCol = ColumnType<Date | string, Date | string | undefined, Date | string>;
type NullableTimestampCol = ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
type VectorCol = ColumnType<unknown, string | Uint8Array | null | undefined, string | Uint8Array | null>;


export interface DocumentsTable {
  id: Generated<number>;
  created_at: TimestampCol;
  user_id: string | null;
  raw_content: string;
  content_hash: string;
  title: string;
}

export interface DocumentChunksTable {
  id: Generated<number>;
  created_at: TimestampCol;
  document_id: number | null;
  chunk_index: Generated<number>;
  chunk_text: string;
  embedding: VectorCol;
}

export interface ConversationsTable {
  id: Generated<number>;
  user_id: string;
  title: string | null;
  compacted_summary: string | null;
  compacted_through_message_id: number | null;
  created_at: TimestampCol;
  updated_at: TimestampCol;
}

export interface MessagesTable {
  id: Generated<number>;
  conversation_id: number;
  role: string;
  content: string;
  trace: JSONColumnType<MessageTrace | null, string | null | undefined, string | null>;
  created_at: TimestampCol;
  embedding: VectorCol;
  tools_used: JSONColumnType<string[], string | null | undefined, string | null>;
}

export interface RunsTable {
  id: string;
  kind: RunKind;
  status: ColumnType<RunStatus, RunStatus | undefined, RunStatus>;
  conversation_id: number | null;
  message_id: number | null;
  query: string;
  user_id: string | null;
  input: JSONColumnType<object | null, string | null | undefined, string | null>;
  partial: JSONColumnType<object | null, string | null | undefined, string | null>;
  checkpoint: JSONColumnType<
    Checkpoint | null,
    string | null | undefined,
    string | null
  >;
  stop_reason: string | null;
  error: string | null;
  owner: string | null;
  claimed_at: NullableTimestampCol;
  attempts: Generated<number>;
  started_at: TimestampCol;
  updated_at: TimestampCol;
  finished_at: NullableTimestampCol;
}

export interface Database {
  documents: DocumentsTable;
  document_chunks: DocumentChunksTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  runs: RunsTable;
}
