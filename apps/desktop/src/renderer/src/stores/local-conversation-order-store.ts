import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import type { ConversationOrder } from "../platform/local-conversation-order";

export interface ConversationOrderScope {
  apiUrl: string;
  userId: string;
  workspaceId: string;
  deviceId: string;
}

interface ConversationOrderState {
  ordersByScope: Record<string, Record<string, ConversationOrder>>;
  setOrder(scopeKey: string, groupId: string | null, order: ConversationOrder): void;
}

export function conversationOrderScopeKey(scope: ConversationOrderScope): string {
  return JSON.stringify([scope.apiUrl.replace(/\/+$/, ""), scope.userId, scope.workspaceId, scope.deviceId]);
}

export function conversationOrderGroupKey(groupId: string | null): string {
  return JSON.stringify(groupId);
}

const ids = z.array(z.string().min(1)).refine((values) => new Set(values).size === values.length);
const orderSchema = z.object({ pinned: ids, unpinned: ids });
const savedSchema = z.object({ ordersByScope: z.record(z.string(), z.record(z.string(), z.unknown())) });

export function createConversationOrderStore(storage?: StateStorage) {
  return create<ConversationOrderState>()(persist((set) => ({
    ordersByScope: {},
    setOrder: (scopeKey, groupId, order) => set((state) => ({
      ordersByScope: {
        ...state.ordersByScope,
        [scopeKey]: { ...state.ordersByScope[scopeKey], [conversationOrderGroupKey(groupId)]: order },
      },
    })),
  }), {
    name: "multica_local_conversation_order",
    storage: createJSONStorage(() => storage ?? localStorage),
    partialize: (state) => ({ ordersByScope: state.ordersByScope }),
    merge: (persisted, current) => {
      const saved = savedSchema.safeParse(persisted);
      if (!saved.success) return current;
      const ordersByScope: ConversationOrderState["ordersByScope"] = {};
      for (const [scope, groups] of Object.entries(saved.data.ordersByScope)) {
        ordersByScope[scope] = {};
        for (const [group, value] of Object.entries(groups)) {
          const order = orderSchema.safeParse(value);
          if (order.success) ordersByScope[scope][group] = order.data;
        }
      }
      return { ...current, ordersByScope };
    },
  }));
}

export const useConversationOrderStore = createConversationOrderStore();
