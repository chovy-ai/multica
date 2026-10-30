import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import * as SecureStore from "expo-secure-store";
import type { SessionScope } from "./client";

export function aiDraftKey(scope: SessionScope, id: string) { return JSON.stringify([scope.userId, scope.workspaceId, scope.deviceId, id]); }

export interface PendingSend { requestId: string; text: string; attachments: string[]; queued?: boolean; queueContent?: string; createdAt?: number; }

export const useAIDrafts = create(persist<{
  drafts: Record<string, string>; setDraft(key: string, text: string): void;
  pending: Record<string, PendingSend>;
  setPending(key: string, value: PendingSend | null): void;
}>((set) => ({
  pending: {}, setPending: (key, value) => set((state) => {
    const pending = { ...state.pending };
    if (value) pending[key] = value; else delete pending[key];
    return { pending };
  }),
  drafts: {}, setDraft: (key, text) => set((state) => {
    const drafts = { ...state.drafts };
    if (text) drafts[key] = text; else delete drafts[key];
    return { drafts };
  }),
}), { name: "mobile.ai-session-drafts", storage: createJSONStorage(() => ({
  getItem: SecureStore.getItemAsync,
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: SecureStore.deleteItemAsync,
})) }));
