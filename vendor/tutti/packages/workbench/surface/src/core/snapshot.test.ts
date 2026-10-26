import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";
import {
  createWorkbenchNode,
  createWorkbenchSnapshotFromState,
  createWorkbenchStateFromSnapshot
} from "./snapshot.ts";

test("hydrates canonical workbench state from snapshot nodes", () => {
  const snapshot: WorkbenchSnapshot = {
    schemaVersion: 1,
    nodes: [
      {
        id: "workspace-files",
        kind: "workspaceFiles",
        title: "Files",
        frame: { x: 120, y: 80, width: 640, height: 480 },
        restoreFrame: null
      }
    ],
    nodeStack: ["workspace-files"]
  };

  const state = createWorkbenchStateFromSnapshot<{ workspaceID: string }>(
    snapshot
  );

  assert.deepEqual(state.nodeStack, ["workspace-files"]);
  assert.deepEqual(state.nodes[0]?.frame, {
    x: 120,
    y: 80,
    width: 640,
    height: 480
  });
  assert.equal(state.nodes[0]?.displayMode, "floating");
  assert.equal(state.nodes[0]?.isMinimized, false);
});

test("serializes canonical workbench state back to canonical snapshot shape", () => {
  const state = {
    nodes: [
      createWorkbenchNode({
        id: "workspace-files",
        kind: "workspaceFiles",
        title: "Files",
        frame: { x: 120, y: 80, width: 640, height: 480 },
        restoreFrame: null,
        data: {
          workspaceID: "workspace-1"
        }
      })
    ],
    nodeStack: ["workspace-files"]
  };

  const snapshot = createWorkbenchSnapshotFromState(state, {
    metadata: {
      tuttiWorkbenchInitialized: true
    }
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.nodes[0]?.frame, {
    x: 120,
    y: 80,
    width: 640,
    height: 480
  });
  assert.equal(snapshot.activeNodeId, "workspace-files");
  assert.deepEqual(snapshot.metadata, {
    tuttiWorkbenchInitialized: true
  });
});

test("serializes the surface layout basis with workbench state", () => {
  const snapshot = createWorkbenchSnapshotFromState({
    layoutConstraints: {
      minWidth: 280,
      minHeight: 160,
      surfacePadding: 8,
      safeArea: { top: 52, right: 12, bottom: 88, left: 12 }
    },
    nodeStack: [],
    nodes: [],
    surfaceSize: { width: 1512, height: 897 }
  });

  assert.deepEqual(snapshot.layoutBasis, {
    surfaceSize: { width: 1512, height: 897 },
    layoutConstraints: {
      minWidth: 280,
      minHeight: 160,
      surfacePadding: 8,
      safeArea: { top: 52, right: 12, bottom: 88, left: 12 }
    }
  });
});

test("round-trips a locked layout through the snapshot contract", () => {
  const snapshot = createWorkbenchSnapshotFromState({
    lockedLayout: {
      preset: { kind: "row" },
      nodeIDs: ["agent-a", "agent-b"],
      normalizedFrames: {
        "agent-a": { x: 0, y: 0, width: 0.4, height: 1 },
        "agent-b": { x: 0.42, y: 0, width: 0.58, height: 1 }
      }
    },
    nodeStack: ["agent-a", "agent-b"],
    nodes: [
      createWorkbenchNode({
        id: "agent-a",
        kind: "agent",
        title: "Agent A",
        frame: { x: 0, y: 0, width: 400, height: 600 },
        data: {}
      }),
      createWorkbenchNode({
        id: "agent-b",
        kind: "agent",
        title: "Agent B",
        frame: { x: 420, y: 0, width: 580, height: 600 },
        data: {}
      })
    ]
  });

  const restored = createWorkbenchStateFromSnapshot(snapshot);

  assert.deepEqual(restored.lockedLayout, snapshot.lockedLayout);
});

test("omits the layout basis while the measured surface is collapsed", () => {
  const snapshot = createWorkbenchSnapshotFromState({
    layoutConstraints: {
      minWidth: 280,
      minHeight: 160,
      surfacePadding: 8,
      safeArea: { top: 52, right: 12, bottom: 88, left: 12 }
    },
    nodeStack: [],
    nodes: [],
    surfaceSize: { width: 0, height: 0 }
  });

  assert.equal(snapshot.layoutBasis, undefined);
});
