import { create } from "zustand";
import type { LocalConversationScope } from "@multica/core/local-conversation/protocol";

interface ProjectExpansionState {
  collapsedByScope: Record<string, string[]>;
  setProjectCollapsed: (
    scope: LocalConversationScope,
    deviceId: string,
    projectId: string,
    collapsed: boolean
  ) => void;
}

export function projectExpansionScopeKey(scope: LocalConversationScope, deviceId: string): string {
  return JSON.stringify([scope.userId, scope.workspaceId, deviceId]);
}

// Keep list preferences for this renderer's lifetime, including across page remounts.
export function createProjectExpansionStore() {
  return create<ProjectExpansionState>((set) => ({
    collapsedByScope: {},
    setProjectCollapsed: (scope, deviceId, projectId, collapsed) => {
      if (!scope.userId || !scope.workspaceId || !deviceId || !projectId) return;
      const key = projectExpansionScopeKey(scope, deviceId);
      set((state) => {
        const previous = state.collapsedByScope[key] ?? [];
        if (previous.includes(projectId) === collapsed) return state;
        const next = collapsed ? [...previous, projectId] : previous.filter((id) => id !== projectId);
        return { collapsedByScope: { ...state.collapsedByScope, [key]: next } };
      });
    },
  }));
}

export const useProjectExpansionStore = createProjectExpansionStore();
