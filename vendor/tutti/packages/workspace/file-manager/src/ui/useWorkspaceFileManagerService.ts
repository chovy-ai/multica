import { useSnapshot } from "valtio";
import type { WorkspaceFileManagerI18nRuntime } from "../i18n/workspaceFileManagerI18n.ts";
import {
  resolveWorkspaceFileManagerContextMenuViewState,
  resolveWorkspaceFileManagerDialogsViewState,
  resolveWorkspaceFileManagerPanelsViewState,
  resolveWorkspaceFileManagerRootViewState,
  resolveWorkspaceFileManagerToolbarViewState
} from "../services/internal/workspaceFileManagerViewModel.ts";
import type { WorkspaceFileManagerSession } from "../services/workspaceFileManagerService.interface.ts";

export function useWorkspaceFileManagerRootView(
  session: WorkspaceFileManagerSession
): ReturnType<typeof resolveWorkspaceFileManagerRootViewState> {
  const state = useSnapshot(
    session.store
  ) as WorkspaceFileManagerSession["store"];

  return resolveWorkspaceFileManagerRootViewState({ state });
}

export function useWorkspaceFileManagerToolbarView(
  session: WorkspaceFileManagerSession,
  i18n: WorkspaceFileManagerI18nRuntime
) {
  const state = useSnapshot(
    session.store
  ) as WorkspaceFileManagerSession["store"];

  return {
    view: resolveWorkspaceFileManagerToolbarViewState({
      copy: i18n,
      state
    })
  };
}

export function useWorkspaceFileManagerPanelsView(
  session: WorkspaceFileManagerSession
) {
  const state = useSnapshot(
    session.store
  ) as WorkspaceFileManagerSession["store"];

  return {
    state,
    view: resolveWorkspaceFileManagerPanelsViewState({
      state
    })
  };
}

export function useWorkspaceFileManagerDialogsView(
  session: WorkspaceFileManagerSession
) {
  const state = useSnapshot(
    session.store
  ) as WorkspaceFileManagerSession["store"];

  return {
    state,
    view: resolveWorkspaceFileManagerDialogsViewState({
      state
    })
  };
}

export function useWorkspaceFileManagerContextMenuView(
  session: WorkspaceFileManagerSession
) {
  const state = useSnapshot(
    session.store
  ) as WorkspaceFileManagerSession["store"];

  return {
    state,
    view: resolveWorkspaceFileManagerContextMenuViewState({
      state
    })
  };
}
