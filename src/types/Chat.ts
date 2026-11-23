import { MessageTrace } from "../db/schema";
import { AgentEvent } from "./ToolExecutionTypes";
import z from 'zod'
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WorkflowNameRegistry {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WorkflowAgentRegistry {}

export type WorkflowName = [keyof WorkflowNameRegistry] extends [never]
  ? string
  : keyof WorkflowNameRegistry;

export type WorkflowAgent = [keyof WorkflowAgentRegistry] extends [never]
  ? string
  : keyof WorkflowAgentRegistry;

export interface WorkflowAgentProgress {
  agent: WorkflowAgent;
  state: "running" | "done" | "failed";
}

export type SseEvent =
  | AgentEvent
  | { type: "init"; conversationId: number; runId?: string }
  | { type: "done" };

export type SseFrame = { type: string } & Record<string, unknown>;

/**
 * What the run registry, the event store and the replay endpoints carry.
 *
 * A chat turn speaks `SseEvent`; a workflow speaks its own frames
 * (`research_start`, `research_url`, `research_result`). Both are published and
 * both are replayed by `GET /api/runs/{id}/stream`, so storage is typed on the
 * union rather than on `SseEvent` — otherwise every publish of a workflow frame
 * would need a cast, and `streamFromRun` could not type what it replays.
 */
export type StoredEvent = SseEvent | SseFrame;


export const whoIsUser = z.object({
  locale: z
    .string()
    .optional()
    .describe("The user's locale or language preference (e.g., 'en-US')."),
  timezone: z
    .string()
    .optional()
    .describe("The user's timezone (e.g., 'America/New_York')."),
  currentDate: z
    .string()
    .optional()
    .describe("The current date and time in the user's context."),
  geo: z
    .string()
    .optional()
    .describe("The user's geographical location or region."),
  other: z
    .array(z.string())
    .optional()
    .describe("Any other relevant context or metadata about the user."),
});

export const fileUploadSchema = z
  .file({ error: "Must be a File" })
  .min(10, { error: "File cannot be empty" })
  .max(10_000_000, { error: "File exceeds 10MB limit (10,000,000 bytes)" })
  .mime(
    [
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    { error: "Unsupported file format" },
  );
  
export const askSchema = z.object({
  user: whoIsUser
    .optional()
    .describe("Optional context about the user making the request."),
  files: z.array(fileUploadSchema).max(3).optional(),
  currentMessage: z
    .string()
    .describe("The current message or prompt from the user."),
});

export type AskSchema = z.infer<typeof askSchema>;
export type AgentPayload = AskSchema & {
  conversationHistory: {
    id: number;
    role: "user" | "assistant";
    message: string;
    /** Persisted tool/reasoning trace; only assistant rows carry it. */
    trace?: MessageTrace | null;
  }[];
};