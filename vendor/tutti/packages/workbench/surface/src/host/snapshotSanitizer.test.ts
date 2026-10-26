import assert from "node:assert/strict";
import test from "node:test";
import { workbenchSnapshotSchemaVersion } from "@tutti-os/workbench-snapshot";
import { sanitizeWorkbenchHostSnapshot } from "./snapshotSanitizer.ts";

test("sanitizeWorkbenchHostSnapshot keeps only shell state and host identity", () => {
  const sanitized = sanitizeWorkbenchHostSnapshot({
    schemaVersion: workbenchSnapshotSchemaVersion,
    nodes: [
      {
        id: "terminal:session-1",
        kind: "terminal",
        title: "Terminal",
        frame: { x: 20, y: 30, width: 800, height: 500 },
        displayMode: "fullscreen",
        restoreFrame: { x: 10, y: 10, width: 640, height: 420 },
        isMinimized: true,
        adapterState: {
          runtimeOwned: true
        },
        data: {
          cwd: "/workspace",
          dockEntryId: "terminal",
          exitCode: 0,
          snapshotNodeState: {
            activePaneId: "preview"
          },
          instanceId: "session-1",
          instanceKey: "workspace-terminal",
          isProjected: true,
          status: "running",
          subject: {
            id: "session-1",
            type: "terminal-session"
          },
          runtimeNodeState: {
            selectedTab: "history"
          },
          typeId: "terminal"
        }
      },
      {
        id: "agent:session-1",
        kind: "agent",
        title: "Agent",
        frame: { x: 830, y: 30, width: 400, height: 500 },
        data: {
          instanceId: "session-1",
          typeId: "agent"
        }
      }
    ],
    nodeStack: ["terminal:session-1"],
    activeNodeId: "terminal:session-1",
    spaces: [
      {
        id: "space-1",
        name: "Main",
        nodeIds: ["terminal:session-1"],
        frame: { x: 0, y: 0, width: 1000, height: 700 },
        data: {
          workspaceTreeState: "host-owned"
        }
      }
    ],
    activeSpaceId: "space-1",
    lockedLayout: {
      preset: { kind: "row" },
      nodeIDs: ["terminal:session-1", "agent:session-1"],
      normalizedFrames: {
        "terminal:session-1": { x: 0, y: 0, width: 0.5, height: 1 },
        "agent:session-1": { x: 0.5, y: 0, width: 0.5, height: 1 }
      }
    },
    metadata: {
      hostPayload: {
        agentStatus: "running"
      },
      tuttiWorkbenchInitialized: true,
      workbenchHostInitialized: true
    }
  });

  assert.deepEqual(
    sanitized.nodes.find((node) => node.id === "terminal:session-1"),
    {
      id: "terminal:session-1",
      kind: "terminal",
      title: "Terminal",
      frame: { x: 20, y: 30, width: 800, height: 500 },
      displayMode: "fullscreen",
      restoreFrame: { x: 10, y: 10, width: 640, height: 420 },
      isMinimized: true,
      data: {
        dockEntryId: "terminal",
        snapshotNodeState: {
          activePaneId: "preview"
        },
        instanceId: "session-1",
        instanceKey: "workspace-terminal",
        isProjected: true,
        typeId: "terminal"
      }
    }
  );
  assert.deepEqual(sanitized.spaces?.[0], {
    id: "space-1",
    name: "Main",
    nodeIds: ["terminal:session-1"],
    frame: { x: 0, y: 0, width: 1000, height: 700 }
  });
  assert.deepEqual(sanitized.metadata, {
    tuttiWorkbenchInitialized: true,
    workbenchHostInitialized: true
  });
  assert.deepEqual(sanitized.lockedLayout, {
    preset: { kind: "row" },
    nodeIDs: ["terminal:session-1", "agent:session-1"],
    normalizedFrames: {
      "terminal:session-1": { x: 0, y: 0, width: 0.5, height: 1 },
      "agent:session-1": { x: 0.5, y: 0, width: 0.5, height: 1 }
    }
  });
});

test("sanitizeWorkbenchHostSnapshot drops invalid host node data", () => {
  const sanitized = sanitizeWorkbenchHostSnapshot({
    schemaVersion: workbenchSnapshotSchemaVersion,
    nodes: [
      {
        id: "terminal:session-1",
        kind: "terminal",
        title: "Terminal",
        frame: { x: 20, y: 30, width: 800, height: 500 },
        data: {
          cwd: "/workspace",
          typeId: "terminal"
        }
      }
    ]
  });

  assert.equal("data" in sanitized.nodes[0]!, false);
});
