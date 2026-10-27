import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { LocalConversationScope } from "@multica/core/local-conversation/protocol";

interface ProjectVisibilityState {
  hiddenByScope: Record<string, string[]>;
  setProjectHidden: (scope: LocalConversationScope, projectId: string, hidden: boolean) => void;
}

export function projectVisibilityScopeKey(scope: LocalConversationScope): string {
  return JSON.stringify([scope.userId, scope.workspaceId]);
}

export function createProjectVisibilityStore(storage?: StateStorage) {
  return create<ProjectVisibilityState>()(persist((set) => ({
    hiddenByScope: {},
    setProjectHidden: (scope, projectId, hidden) => {
      if (!scope.userId || !scope.workspaceId || !projectId) return;
      const key = projectVisibilityScopeKey(scope);
      set((state) => {
        const previous = state.hiddenByScope[key] ?? [];
        if (previous.includes(projectId) === hidden) return state;
        const next = hidden ? [...previous, projectId] : previous.filter((id) => id !== projectId);
        return { hiddenByScope: { ...state.hiddenByScope, [key]: next } };
      });
    },
  }), {
    name: "multica_local_conversation_project_visibility",
    storage: createJSONStorage(() => storage ?? localStorage),
    partialize: (state) => ({ hiddenByScope: state.hiddenByScope }),
    merge: (persisted, current) => {
      const saved = (persisted as Partial<ProjectVisibilityState> | null)?.hiddenByScope;
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return current;
      const entries = Object.entries(saved).filter((entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) && entry[1].every((id: unknown) => typeof id === "string" && id.length > 0));
      return { ...current, hiddenByScope: Object.fromEntries(entries) };
    },
  }));
}

export const useProjectVisibilityStore = createProjectVisibilityStore();
