import { EMPTY_COMPACTION_STATE } from "./compactChat";
import { loadConversationHistory } from "../models/loadConversationHistory";
import { AgentPayload } from "../types/Chat";
import { CompactionState } from "../types/Compaction";


export type ResolvedConversation =
  | {
      ok: true;
      id: number;
      history: AgentPayload["conversationHistory"];
      compaction: CompactionState;
    }
  | { ok: false; reason: string };


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
