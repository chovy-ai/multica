import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkspaceFileManagerVisibleTreeRows,
  collectWorkspaceFileManagerVisibleTreeEntries
} from "./workspaceFileManagerVisibleTree.ts";
import type {
  WorkspaceFileDirectoryExpansionState,
  WorkspaceFileEntry
} from "../services/workspaceFileManagerTypes.ts";

test("visible tree rows expand loaded directory children by depth", () => {
  const rows = buildWorkspaceFileManagerVisibleTreeRows({
    arrangeMode: "name",
    directoryExpansionByPath: {
      "/workspace/src": directoryState([
        entry("/workspace/src/index.ts", "file"),
        entry("/workspace/src/components", "directory", true)
      ]),
      "/workspace/src/components": directoryState([
        entry("/workspace/src/components/Button.tsx", "file")
      ])
    },
    entries: [
      entry("/workspace/README.md", "file"),
      entry("/workspace/src", "directory", true)
    ],
    expandedDirectoryPaths: {
      "/workspace/src": true,
      "/workspace/src/components": true
    }
  });

  assert.deepEqual(
    rows.map((row) =>
      row.kind === "entry"
        ? { depth: row.depth, path: row.entry.path }
        : { depth: row.depth, status: row.status }
    ),
    [
      { depth: 0, path: "/workspace/src" },
      { depth: 1, path: "/workspace/src/components" },
      { depth: 2, path: "/workspace/src/components/Button.tsx" },
      { depth: 1, path: "/workspace/src/index.ts" },
      { depth: 0, path: "/workspace/README.md" }
    ]
  );
  assert.deepEqual(
    collectWorkspaceFileManagerVisibleTreeEntries(rows).map(
      (visibleEntry) => visibleEntry.path
    ),
    [
      "/workspace/src",
      "/workspace/src/components",
      "/workspace/src/components/Button.tsx",
      "/workspace/src/index.ts",
      "/workspace/README.md"
    ]
  );
});

test("visible tree rows show child loading, empty, and error states", () => {
  const rows = buildWorkspaceFileManagerVisibleTreeRows({
    arrangeMode: "none",
    directoryExpansionByPath: {
      "/workspace/docs": {
        entries: [],
        error: null,
        isLoading: true,
        loaded: false
      },
      "/workspace/empty": directoryState([]),
      "/workspace/failed": {
        entries: [],
        error: "Permission denied",
        isLoading: false,
        loaded: false
      }
    },
    entries: [
      entry("/workspace/docs", "directory", true),
      entry("/workspace/empty", "directory", true),
      entry("/workspace/failed", "directory", true)
    ],
    expandedDirectoryPaths: {
      "/workspace/docs": true,
      "/workspace/empty": true,
      "/workspace/failed": true
    }
  });

  assert.deepEqual(
    rows
      .filter((row) => row.kind === "feedback")
      .map((row) => ({
        message: row.message,
        parentPath: row.parentPath,
        status: row.status
      })),
    [
      {
        message: undefined,
        parentPath: "/workspace/docs",
        status: "loading"
      },
      {
        message: undefined,
        parentPath: "/workspace/empty",
        status: "empty"
      },
      {
        message: "Permission denied",
        parentPath: "/workspace/failed",
        status: "error"
      }
    ]
  );
});

function directoryState(
  entries: WorkspaceFileEntry[]
): WorkspaceFileDirectoryExpansionState {
  return {
    entries,
    error: null,
    isLoading: false,
    loaded: true
  };
}

function entry(
  path: string,
  kind: WorkspaceFileEntry["kind"],
  hasChildren = false
): WorkspaceFileEntry {
  return {
    createdTimeMs: null,
    hasChildren,
    kind,
    lastOpenedMs: null,
    mtimeMs: null,
    name: path.split("/").at(-1) ?? path,
    path,
    sizeBytes: kind === "directory" ? null : 0
  };
}
