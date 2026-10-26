export type WorkspaceFileManagerLayoutMode = "icon" | "list";

export const workspaceFileManagerLayoutModeStorageKey =
  "tutti.workspace-file-manager.layout-mode";

export function readWorkspaceFileManagerLayoutMode(): WorkspaceFileManagerLayoutMode {
  if (typeof window === "undefined") {
    return "list";
  }

  const stored = window.localStorage.getItem(
    workspaceFileManagerLayoutModeStorageKey
  );
  return stored === "icon" ? "icon" : "list";
}

export function writeWorkspaceFileManagerLayoutMode(
  layoutMode: WorkspaceFileManagerLayoutMode
): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    workspaceFileManagerLayoutModeStorageKey,
    layoutMode
  );
}
