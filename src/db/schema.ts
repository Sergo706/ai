import type { ColumnType, Generated, JSONColumnType } from "kysely";
import type { Checkpoint } from "../types/Checkpoint";

/** One tool invocation recorded on an assistant message. */
export interface StoredToolStep {
  /** Stable id of this step within the message. */
  id: string;
  /** Tool name, as the model called it. */
  name: string;
  /** Arguments the model passed, unvalidated. */
  args: unknown;
  /** Whether the handler reported success. */
  ok: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Position of this call within its round, from 0. */
  callIndex: number;
  /** Total calls in that round. */
  callTotal: number;
  /** The handler's result, as text. */
  result: string;
  /** Hide the result from the UI while keeping it for the model. */
  previewHidden: boolean;
}

/**
 * Everything an assistant message carries besides its text: reasoning rounds,
 * tool steps, and workflow progress.
 */
export interface MessageTrace {
  /** Reasoning text per round, in order. */
  reasoning: { round: number; text: string }[];
  /** Tool calls the model made. */
  steps: StoredToolStep[];
  /** Progress entries a workflow reported. */
  workflow?: {
    title: string;
    runId?: string;
    custom?: Record<string, unknown>;
  }[];
}

/** Terminal and in-flight states a run can be in. */
export type RunStatus = "running" | "finished" | "aborted" | "failed" | "interrupted";

/**
 * Kinds of run this package knows how to resume.
 *
 * Register a new kind here to give it its own checkpoint and resume strategy.
 */
export interface RunKindRegistry {
  chat: true;
  workflow: true;
}
/** A run kind, i.e. a key of {@link RunKindRegistry}. */
export type RunKind = keyof RunKindRegistry;

type TimestampCol = ColumnType<Date | string, Date | string | undefined, Date | string>;
type NullableTimestampCol = ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
type VectorCol = ColumnType<unknown, string | Uint8Array | null | undefined, string | Uint8Array | null>;


/** A scraped document. Chunks point back at it through `document_id`. */
export interface DocumentsTable {
  /** Primary key. */
  id: Generated<number>;
  /** Insert time. */
  created_at: TimestampCol;
  /** Owner, when the host scopes documents per user. */
  user_id: string | null;
  /** The full text that was scraped. */
  raw_content: string;
  /** Hash of `raw_content`, used to skip re-ingesting the same page. */
  content_hash: string;
  /** Page title, if one was found. */
  title: string;
}

/** One embedded slice of a document, searchable by vector distance. */
export interface DocumentChunksTable {
  /** Primary key. */
  id: Generated<number>;
  /** Insert time. */
  created_at: TimestampCol;
  /** Document this chunk came from. */
  document_id: number | null;
  /** Position of the chunk within its document. */
  chunk_index: Generated<number>;
  /** The chunk text that was embedded. */
  chunk_text: string;
  /** Embedding vector, dialect-dependent (pgvector literal or float blob). */
  embedding: VectorCol;
}

/** A chat thread, plus the rolling summary produced by compaction. */
export interface ConversationsTable {
  /** Primary key, also the `conversationId` callers pass in. */
  id: Generated<number>;
  /** Owner of the conversation. */
  user_id: string;
  /** Display title, derived from the first message. */
  title: string | null;
  /** Rolling summary of the messages already compacted. */
  compacted_summary: string | null;
  /** Id of the last message folded into `compacted_summary`. */
  compacted_through_message_id: number | null;
  /** Insert time. */
  created_at: TimestampCol;
  /** Last write time. */
  updated_at: TimestampCol;
}

/** A single user or assistant turn, with its optional trace and embedding. */
export interface MessagesTable {
  /** Primary key. */
  id: Generated<number>;
  /** Conversation this message belongs to. */
  conversation_id: number;
  /** `"user"` or `"assistant"`. */
  role: string;
  /** The message text. */
  content: string;
  /** Reasoning rounds and tool steps, when the assistant called tools. */
  trace: JSONColumnType<MessageTrace | null, string | null | undefined, string | null>;
  /** Insert time. */
  created_at: TimestampCol;
  /** Embedding used for retrieval and the semantic cache. */
  embedding: VectorCol;
  /** Names of the tools the assistant called for this turn. */
  tools_used: JSONColumnType<string[], string | null | undefined, string | null>;
}

/**
 * Durable state for one run: input, partial output, checkpoint and lease.
 *
 * `owner`/`claimed_at` implement the lease that stops two replicas from
 * processing the same run.
 */
export interface RunsTable {
  /** Caller-supplied run id. */
  id: string;
  /** Which resume strategy this run belongs to. */
  kind: RunKind;
  /** Lifecycle state of the run. */
  status: ColumnType<RunStatus, RunStatus | undefined, RunStatus>;
  /** Conversation the run answers, when it is a chat turn. */
  conversation_id: number | null;
  /** Assistant message the run produced, once it finished. */
  message_id: number | null;
  /** The question or task the run works on. */
  query: string;
  /** Owner of the run. */
  user_id: string | null;
  /** Input payload needed to resume. */
  input: JSONColumnType<object | null, string | null | undefined, string | null>;
  /** Partial output kept while the run is in flight. */
  partial: JSONColumnType<object | null, string | null | undefined, string | null>;
  /** Last durable checkpoint written by the runner. */
  checkpoint: JSONColumnType<
    Checkpoint | null,
    string | null | undefined,
    string | null
  >;
  /** Why the run stopped, when the runner recorded a reason. */
  stop_reason: string | null;
  /** Failure message, when the run failed. */
  error: string | null;
  /** Instance currently holding the lease, or `null` when released. */
  owner: string | null;
  /** Last heartbeat from `owner`; a stale value means the owner died. */
  claimed_at: NullableTimestampCol;
  /** How many times this run has been claimed, i.e. resumes plus the first try. */
  attempts: Generated<number>;
  /** Create time. */
  started_at: TimestampCol;
  /** Last write time. */
  updated_at: TimestampCol;
  /** When the run reached a terminal status. */
  finished_at: NullableTimestampCol;
}

/** The Kysely table map. Pass to `Kysely<Database>` for a typed query builder. */
export interface Database {
  documents: DocumentsTable;
  document_chunks: DocumentChunksTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  runs: RunsTable;
}
