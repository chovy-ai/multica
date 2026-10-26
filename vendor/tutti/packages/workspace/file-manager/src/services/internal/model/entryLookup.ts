import type {
  WorkspaceFileEntry,
  WorkspaceFileManagerState
} from "../../workspaceFileManagerTypes.ts";
import { workspaceFileSearchEntryToEntry } from "./searchEntries.ts";

export function findWorkspaceFileEntry(
  state: WorkspaceFileManagerState,
  entryPath: string | null | undefined
): WorkspaceFileEntry | null {
  if (!entryPath) {
    return null;
  }

  const directEntry = state.entries.find((entry) => entry.path === entryPath);
  if (directEntry) {
    return directEntry;
  }

  for (const directoryState of Object.values(state.directoryExpansionByPath)) {
    const nestedEntry = directoryState.entries.find(
      (entry) => entry.path === entryPath
    );
    if (nestedEntry) {
      return nestedEntry;
    }
  }

  const searchEntry = state.searchEntries.find(
    (entry) => entry.path === entryPath
  );
  if (searchEntry) {
    return workspaceFileSearchEntryToEntry(searchEntry);
  }

  return null;
}
