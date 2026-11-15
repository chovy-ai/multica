import type { LocalSessionEntry } from "./local-conversation-projects";

export interface ConversationOrder {
  pinned: string[];
  unpinned: string[];
}

/** Input is in the default recency order. Newly seen conversations precede saved ones. */
export function orderLocalConversations(sessions: LocalSessionEntry[], order?: ConversationOrder): LocalSessionEntry[] {
  if (!order) return sessions;
  return [true, false].flatMap((pinned) => {
    const entries = sessions.filter((entry) => entry.pinned === pinned);
    const ranks = new Map((pinned ? order.pinned : order.unpinned).map((id, index) => [id, index]));
    return entries.toSorted((a, b) => (ranks.get(a.id) ?? -1) - (ranks.get(b.id) ?? -1));
  });
}

/** Reorder the complete group so filtered, archived and paginated rows keep their place. */
export function reorderLocalConversations(sessions: LocalSessionEntry[], order: ConversationOrder | undefined, activeId: string, overId: string): ConversationOrder | undefined {
  const active = sessions.find((entry) => entry.id === activeId);
  const over = sessions.find((entry) => entry.id === overId);
  if (!active || !over || activeId === overId || active.pinned !== over.pinned) return;
  const ordered = [...orderLocalConversations(sessions, order)];
  const from = ordered.findIndex((entry) => entry.id === activeId);
  const to = ordered.findIndex((entry) => entry.id === overId);
  ordered.splice(from, 1);
  ordered.splice(to, 0, active);
  return {
    pinned: ordered.filter((entry) => entry.pinned).map((entry) => entry.id),
    unpinned: ordered.filter((entry) => !entry.pinned).map((entry) => entry.id),
  };
}
