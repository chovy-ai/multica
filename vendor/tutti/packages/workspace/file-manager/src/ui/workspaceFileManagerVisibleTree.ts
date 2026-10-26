import type {
  WorkspaceFileDirectoryExpansionState,
  WorkspaceFileEntry
} from "../services/workspaceFileManagerTypes.ts";
import {
  sortWorkspaceFileEntriesForArrangeMode,
  type WorkspaceFileManagerArrangeMode
} from "./workspaceFileManagerArrangeMode.ts";

export type WorkspaceFileManagerVisibleTreeRow =
  | {
      depth: number;
      entry: WorkspaceFileEntry;
      expanded: boolean;
      expandable: boolean;
      kind: "entry";
      loadingChildren: boolean;
    }
  | {
      depth: number;
      key: string;
      kind: "feedback";
      parentPath: string;
      status: "empty" | "error" | "loading";
      message?: string;
    };

export function buildWorkspaceFileManagerVisibleTreeRows(input: {
  arrangeMode: WorkspaceFileManagerArrangeMode;
  directoryExpansionByPath: Record<
    string,
    WorkspaceFileDirectoryExpansionState
  >;
  entries: readonly WorkspaceFileEntry[];
  expandedDirectoryPaths: Record<string, boolean>;
}): WorkspaceFileManagerVisibleTreeRow[] {
  return appendWorkspaceFileManagerVisibleTreeRows({
    ...input,
    depth: 0
  });
}

export function collectWorkspaceFileManagerVisibleTreeEntries(
  rows: readonly WorkspaceFileManagerVisibleTreeRow[]
): WorkspaceFileEntry[] {
  return rows.flatMap((row) => (row.kind === "entry" ? [row.entry] : []));
}

function appendWorkspaceFileManagerVisibleTreeRows(input: {
  arrangeMode: WorkspaceFileManagerArrangeMode;
  depth: number;
  directoryExpansionByPath: Record<
    string,
    WorkspaceFileDirectoryExpansionState
  >;
  entries: readonly WorkspaceFileEntry[];
  expandedDirectoryPaths: Record<string, boolean>;
}): WorkspaceFileManagerVisibleTreeRow[] {
  const sortedEntries = sortWorkspaceFileEntriesForArrangeMode(
    input.entries,
    input.arrangeMode
  );
  const rows: WorkspaceFileManagerVisibleTreeRow[] = [];

  for (const entry of sortedEntries) {
    const expandable = entry.kind === "directory" && entry.hasChildren;
    const expanded = expandable
      ? input.expandedDirectoryPaths[entry.path] === true
      : false;
    const childState = input.directoryExpansionByPath[entry.path];
    rows.push({
      depth: input.depth,
      entry,
      expanded,
      expandable,
      kind: "entry",
      loadingChildren: childState?.isLoading ?? false
    });

    if (!expanded) {
      continue;
    }

    if (!childState || childState.isLoading) {
      rows.push({
        depth: input.depth + 1,
        key: `${entry.path}:loading`,
        kind: "feedback",
        parentPath: entry.path,
        status: "loading"
      });
      continue;
    }

    if (childState.error) {
      rows.push({
        depth: input.depth + 1,
        key: `${entry.path}:error`,
        kind: "feedback",
        message: childState.error,
        parentPath: entry.path,
        status: "error"
      });
      continue;
    }

    if (childState.loaded && childState.entries.length === 0) {
      rows.push({
        depth: input.depth + 1,
        key: `${entry.path}:empty`,
        kind: "feedback",
        parentPath: entry.path,
        status: "empty"
      });
      continue;
    }

    rows.push(
      ...appendWorkspaceFileManagerVisibleTreeRows({
        ...input,
        depth: input.depth + 1,
        entries: childState.entries
      })
    );
  }

  return rows;
}
