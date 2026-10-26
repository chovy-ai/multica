import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export const SESSION_LIST_MIN_WIDTH = 240;
export const SESSION_LIST_MAX_WIDTH = 480;
const DEFAULT_WIDTH = 268;

interface ConversationLayoutState {
  sessionListWidth: number;
  setSessionListWidth(width: number): void;
}

function validWidth(width: unknown): width is number {
  return typeof width === "number" && Number.isFinite(width) && width >= SESSION_LIST_MIN_WIDTH && width <= SESSION_LIST_MAX_WIDTH;
}

export function createConversationLayoutStore(storage?: StateStorage) {
  return create<ConversationLayoutState>()(persist((set) => ({
    sessionListWidth: DEFAULT_WIDTH,
    setSessionListWidth: (width) => {
      if (validWidth(width)) set({ sessionListWidth: Math.round(width) });
    },
  }), {
    name: "multica_local_conversation_width",
    storage: createJSONStorage(() => storage ?? localStorage),
    partialize: (state) => ({ sessionListWidth: state.sessionListWidth }),
    merge: (saved, current) => {
      const width = (saved as Partial<ConversationLayoutState> | null)?.sessionListWidth;
      return validWidth(width) ? { ...current, sessionListWidth: Math.round(width) } : current;
    },
  }));
}

export const useConversationLayoutStore = createConversationLayoutStore();
