import assert from "node:assert/strict";
import test from "node:test";
import type {
  IssueManagerFileReference,
  IssueManagerReferenceTreeSnapshot
} from "../../../../contracts/index.ts";
import {
  createReferenceDirectoryStateFromSnapshot,
  issueManagerReferenceDefaultExpandedDepth,
  mergeExpandedFolderPaths,
  mergePrefetchedDirectoryState,
  prefetchReferenceTree
} from "./IssueManagerReferencePickerState.ts";

test("prefetchReferenceTree expands four directory levels by default", async () => {
  const listDirectory = async (path: string) => ({
    displayPath: path,
    entries: referenceTree[path] ?? [],
    normalizedPath: path
  });

  const prefetched = await prefetchReferenceTree({
    listDirectory,
    maxDepth: issueManagerReferenceDefaultExpandedDepth,
    path: "/workspace"
  });

  assert.deepEqual(Object.keys(prefetched.expandedFolderPaths).sort(), [
    "/workspace",
    "/workspace/apps",
    "/workspace/apps/desktop",
    "/workspace/apps/desktop/src"
  ]);
  assert.deepEqual(
    prefetched.directoryStateByPath["/workspace/apps/desktop/src"]?.entries,
    referenceTree["/workspace/apps/desktop/src"]
  );
  assert.equal(
    prefetched.directoryStateByPath["/workspace/apps/desktop/src/features"],
    undefined
  );
});

test("prefetched tree merges keep user-expanded folders and deeper loaded state", () => {
  const mergedExpanded = mergeExpandedFolderPaths(
    {
      "/workspace": true,
      "/workspace/apps": true,
      "/workspace/apps/desktop/src/features": true
    },
    {
      "/workspace": true,
      "/workspace/apps": true,
      "/workspace/apps/desktop": true,
      "/workspace/apps/desktop/src": true
    }
  );

  const mergedDirectoryState = mergePrefetchedDirectoryState(
    {
      "/workspace/apps/desktop/src/features": {
        displayPath: "/workspace/apps/desktop/src/features",
        entries: [
          {
            kind: "folder",
            path: "/workspace/apps/desktop/src/features/workspace-issue-manager"
          }
        ],
        loaded: true,
        loading: false
      }
    },
    {
      "/workspace": {
        displayPath: "/workspace",
        entries: referenceTree["/workspace"]!,
        loaded: true,
        loading: false
      }
    }
  );

  assert.equal(mergedExpanded["/workspace/apps/desktop/src/features"], true);
  assert.deepEqual(
    mergedDirectoryState["/workspace/apps/desktop/src/features"]?.entries,
    [
      {
        kind: "folder",
        path: "/workspace/apps/desktop/src/features/workspace-issue-manager"
      }
    ]
  );
});

test("prefetchReferenceTree keeps readable branches when one child directory fails", async () => {
  const listDirectory = async (path: string) => {
    if (path === "/workspace/.Trash") {
      throw new Error("operation not permitted");
    }
    return {
      displayPath: path,
      entries: failingReferenceTree[path] ?? [],
      normalizedPath: path
    };
  };

  const prefetched = await prefetchReferenceTree({
    listDirectory,
    maxDepth: issueManagerReferenceDefaultExpandedDepth,
    path: "/workspace"
  });

  assert.deepEqual(prefetched.directoryStateByPath["/workspace"]?.entries, [
    { kind: "folder", path: "/workspace/.Trash" },
    { kind: "folder", path: "/workspace/project" }
  ]);
  assert.equal(prefetched.expandedFolderPaths["/workspace/project"], true);
  assert.equal(
    prefetched.directoryStateByPath["/workspace/project"]?.loaded,
    true
  );
  assert.equal(prefetched.directoryStateByPath["/workspace/.Trash"], undefined);
});

test("createReferenceDirectoryStateFromSnapshot seeds partial and deferred folder states", () => {
  const snapshot: IssueManagerReferenceTreeSnapshot = {
    budgetExceeded: true,
    directory: {
      directoryPath: "/workspace",
      entries: [
        {
          hasChildren: true,
          kind: "folder",
          path: "/workspace/docs",
          prefetchedDirectory: {
            directoryPath: "/workspace/docs",
            entries: [
              {
                hasChildren: true,
                kind: "folder",
                path: "/workspace/docs/specs",
                prefetchReason: "depth_limit_reached",
                prefetchState: "not_loaded"
              }
            ],
            prefetchState: "partial"
          },
          prefetchState: "partial"
        }
      ],
      prefetchState: "partial"
    },
    prefetchBudgetMs: 500,
    prefetchDepth: 4,
    rootPath: "/workspace"
  };

  const state = createReferenceDirectoryStateFromSnapshot(snapshot);

  assert.equal(state["/workspace"]?.loaded, true);
  assert.equal(state["/workspace/docs"]?.loaded, true);
  assert.equal(state["/workspace/docs"]?.prefetchState, "partial");
  assert.equal(state["/workspace/docs/specs"]?.loaded, false);
  assert.equal(
    state["/workspace/docs/specs"]?.prefetchReason,
    "depth_limit_reached"
  );
});

const referenceTree: Record<string, IssueManagerFileReference[]> = {
  "/workspace": [
    { kind: "folder", path: "/workspace/apps" },
    { kind: "file", path: "/workspace/README.md" }
  ],
  "/workspace/apps": [{ kind: "folder", path: "/workspace/apps/desktop" }],
  "/workspace/apps/desktop": [
    { kind: "folder", path: "/workspace/apps/desktop/src" }
  ],
  "/workspace/apps/desktop/src": [
    { kind: "folder", path: "/workspace/apps/desktop/src/features" }
  ],
  "/workspace/apps/desktop/src/features": [
    {
      kind: "folder",
      path: "/workspace/apps/desktop/src/features/workspace-issue-manager"
    }
  ]
};

const failingReferenceTree: Record<string, IssueManagerFileReference[]> = {
  "/workspace": [
    { kind: "folder", path: "/workspace/.Trash" },
    { kind: "folder", path: "/workspace/project" }
  ],
  "/workspace/project": [{ kind: "file", path: "/workspace/project/README.md" }]
};
