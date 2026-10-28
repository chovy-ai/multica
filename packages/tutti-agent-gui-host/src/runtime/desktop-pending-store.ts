import { createStore } from "zustand/vanilla";
import { readSavedPromptQueues, type SavedPromptQueue } from "./saved-prompt-queues";

interface DesktopPendingState {
  queues: SavedPromptQueue[];
  setQueues(queues: SavedPromptQueue[]): void;
}

/** Checkpoint only submissions whose ownership has not transferred to Electron. */
export function createDesktopPendingStore(storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">, namespace?: string) {
  const key = namespace ? `multica:desktop-pending:v1:${namespace}` : null;
  let queues: SavedPromptQueue[] = [];
  if (storage && key) {
    try { queues = readSavedPromptQueues(JSON.parse(storage.getItem(key) ?? "null")); }
    catch (error) { console.warn("Could not restore pending submissions", error); }
  }
  return createStore<DesktopPendingState>()((set) => ({
    queues,
    setQueues(next) {
      const queues = readSavedPromptQueues(next);
      if (storage && key) {
        try {
          if (queues.length) storage.setItem(key, JSON.stringify(queues));
          else storage.removeItem(key);
        } catch (error) { console.warn("Could not save pending submissions", error); }
      }
      set({ queues });
    },
  }));
}

export type DesktopPendingStore = ReturnType<typeof createDesktopPendingStore>;
