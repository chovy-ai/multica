import type {
  WorkspaceFileEntry,
  WorkspaceFileSearchEntry
} from "../../workspaceFileManagerTypes.ts";

export function workspaceFileSearchEntryToEntry(
  entry: WorkspaceFileSearchEntry
): WorkspaceFileEntry {
  return {
    hasChildren: entry.kind === "directory",
    kind: entry.kind,
    mtimeMs: null,
    name: entry.name,
    path: entry.path,
    sizeBytes: null
  };
}
