import type {
  WorkspaceFileReference,
  WorkspaceFileReferencePrefetchReason,
  WorkspaceFileReferencePrefetchState,
  WorkspaceFileReferenceTreeSnapshot
} from "../../../contracts/index.ts";

export const workspaceFileReferenceDefaultExpandedDepth = 4;

export interface WorkspaceFileReferenceDirectoryState {
  displayPath: string;
  entries: WorkspaceFileReference[];
  loaded: boolean;
  loading: boolean;
  prefetchReason?: WorkspaceFileReferencePrefetchReason | null;
  prefetchState?: WorkspaceFileReferencePrefetchState | null;
}

export function normalizeDirectoryPath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }
  return path.replace(/\/+$/, "") || "/";
}

export function collectVisibleTreeEntries(
  entries: readonly WorkspaceFileReference[],
  directoryStateByPath: Record<string, WorkspaceFileReferenceDirectoryState>,
  expandedFolderPaths: Record<string, boolean>
): WorkspaceFileReference[] {
  const collected: WorkspaceFileReference[] = [];

  for (const entry of entries) {
    collected.push(entry);
    if (entry.kind !== "folder") {
      continue;
    }
    const folderKey = normalizeDirectoryPath(entry.path);
    if (!expandedFolderPaths[folderKey]) {
      continue;
    }
    const childEntries = directoryStateByPath[folderKey]?.entries ?? [];
    if (childEntries.length === 0) {
      continue;
    }
    collected.push(
      ...collectVisibleTreeEntries(
        childEntries,
        directoryStateByPath,
        expandedFolderPaths
      )
    );
  }

  return collected;
}

export function mergeExpandedFolderPaths(
  current: Record<string, boolean>,
  prefetched: Record<string, boolean>
): Record<string, boolean> {
  return {
    ...prefetched,
    ...current
  };
}

export function mergePrefetchedDirectoryState(
  current: Record<string, WorkspaceFileReferenceDirectoryState>,
  prefetched: Record<string, WorkspaceFileReferenceDirectoryState>
): Record<string, WorkspaceFileReferenceDirectoryState> {
  return {
    ...current,
    ...prefetched
  };
}

export function createWorkspaceFileReferenceDirectoryStateFromSnapshot(
  snapshot: WorkspaceFileReferenceTreeSnapshot
): Record<string, WorkspaceFileReferenceDirectoryState> {
  const stateByPath: Record<string, WorkspaceFileReferenceDirectoryState> = {};
  addReferenceDirectoryStateFromSnapshot(stateByPath, snapshot.directory);
  return stateByPath;
}

function addReferenceDirectoryStateFromSnapshot(
  stateByPath: Record<string, WorkspaceFileReferenceDirectoryState>,
  directory: WorkspaceFileReferenceTreeSnapshot["directory"]
) {
  const normalizedPath = normalizeDirectoryPath(directory.directoryPath);
  stateByPath[normalizedPath] = {
    displayPath: directory.directoryPath,
    entries: directory.entries.map((entry) => ({
      displayName: entry.displayName,
      kind: entry.kind,
      path: entry.path
    })),
    loaded: true,
    loading: false,
    prefetchReason: directory.prefetchReason,
    prefetchState: directory.prefetchState
  };

  for (const entry of directory.entries) {
    if (entry.kind !== "folder") {
      continue;
    }
    const folderKey = normalizeDirectoryPath(entry.path);
    if (entry.prefetchedDirectory) {
      addReferenceDirectoryStateFromSnapshot(
        stateByPath,
        entry.prefetchedDirectory
      );
      continue;
    }
    if (entry.prefetchState) {
      stateByPath[folderKey] = {
        displayPath: entry.path,
        entries: [],
        loaded: false,
        loading: false,
        prefetchReason: entry.prefetchReason,
        prefetchState: entry.prefetchState
      };
    }
  }
}

export async function prefetchReferenceTree(input: {
  listDirectory: (path: string) => Promise<{
    displayPath: string;
    entries: WorkspaceFileReference[];
    normalizedPath: string;
  } | null>;
  maxDepth: number;
  path: string;
  depth?: number;
}): Promise<{
  directoryStateByPath: Record<string, WorkspaceFileReferenceDirectoryState>;
  expandedFolderPaths: Record<string, boolean>;
}> {
  const { depth = 1, listDirectory, maxDepth, path } = input;
  const listing = await listDirectory(path);
  if (!listing) {
    return {
      directoryStateByPath: {},
      expandedFolderPaths: {}
    };
  }

  const directoryStateByPath: Record<
    string,
    WorkspaceFileReferenceDirectoryState
  > = {
    [listing.normalizedPath]: {
      displayPath: listing.displayPath,
      entries: listing.entries,
      loaded: true,
      loading: false
    }
  };
  const expandedFolderPaths: Record<string, boolean> = {
    [listing.normalizedPath]: true
  };

  if (depth >= maxDepth) {
    return {
      directoryStateByPath,
      expandedFolderPaths
    };
  }

  for (const entry of listing.entries) {
    if (entry.kind !== "folder") {
      continue;
    }
    try {
      const childTree = await prefetchReferenceTree({
        depth: depth + 1,
        listDirectory,
        maxDepth,
        path: entry.path
      });
      Object.assign(directoryStateByPath, childTree.directoryStateByPath);
      Object.assign(expandedFolderPaths, childTree.expandedFolderPaths);
    } catch {
      // Skip unreadable branches so one protected folder does not blank the whole tree.
    }
  }

  return {
    directoryStateByPath,
    expandedFolderPaths
  };
}
