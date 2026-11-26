import { EMPTY_COMPACTION_STATE } from "./compactChat";
import { loadConversationHistory } from "../models/loadConversationHistory";
import { AgentPayload } from "../types/Chat";
import { CompactionState } from "../types/Compaction";

/**
 * The turn's conversation, or the reason it could not be resolved.
 *
 * Discriminated on `ok` so a caller cannot read `id` without having checked.
 */
export type ResolvedConversation =
  | {
      ok: true;
      /** Conversation to store the turn under. */
      id: number;
      /** Turns already stored, oldest first. Empty for a new conversation. */
      history: AgentPayload["conversationHistory"];
      /** Where the previous summary ended. */
      compaction: CompactionState;
    }
  | {
      ok: false;
      /** Why the conversation could not be loaded. */
      reason: string;
    };

/**
 * Find or create the conversation a turn belongs to.
 *
 * A missing `conversationId` starts a new conversation titled with the first
 * message. An existing one is loaded with its history and compaction state.
 *
 * @param userId - Owner of the conversation.
 * @param conversationId - Existing conversation, or `undefined` to start one.
 * @param firstMessage - Used as the title when starting.
 * @returns The conversation with its history, or `ok: false` and a reason.
 */
export async function resolveConversation(
  userId: string,
  conversationId: number | undefined,
  firstMessage: string,
): Promise<ResolvedConversation> {
  const res = await loadConversationHistory(
    userId,
    conversationId,
    firstMessage,
  );

  if (res.ok && res.data?.existedId) {
    return {
      ok: true,
      id: res.data.existedId,
      history: res.data.conversation,
      compaction: res.data.compaction,
    };
  }
  if (res.ok && res.data?.newConversationId) {
    return {
      ok: true,
      id: res.data.newConversationId,
      history: [],
      compaction: EMPTY_COMPACTION_STATE,
    };
  }
  return {
    ok: false,
    reason: res.reason ?? "Conversation could not be loaded",
  };
}
