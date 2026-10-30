import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import * as SecureStore from "expo-secure-store";

export interface SideLayout { tab: "files" | "web" | "side"; url?: string; sideId?: string }

export const useAIViewPreferences = create(persist<{
  collapsed: Record<string, boolean>;
  layouts: Record<string, SideLayout>;
  setLayout(key: string, patch: Partial<SideLayout>): void;
  toggle(key: string): void;
}>((set) => ({ collapsed: {}, layouts: {}, setLayout: (key, patch) => set((state) => ({ layouts: { ...state.layouts, [key]: { ...(state.layouts[key] ?? { tab: "files" }), ...patch } } })), toggle: (key) => set((state) => ({ collapsed: { ...state.collapsed, [key]: !state.collapsed[key] } })) }), {
  name: "mobile.ai-session-preferences",
  storage: createJSONStorage(() => ({ getItem: SecureStore.getItemAsync, setItem: (key, value) => SecureStore.setItemAsync(key, value), removeItem: SecureStore.deleteItemAsync })),
}));
