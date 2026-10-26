import assert from "node:assert/strict";
import test from "node:test";
import { readWorkbenchHostExternalState } from "./externalState.ts";
import type { WorkbenchHostExternalStateLookupInput } from "./types.ts";

const node = {
  data: {
    instanceId: "browser-1",
    instanceKey: "https://example.com",
    typeId: "browser"
  },
  displayMode: "floating" as const,
  frame: { x: 10, y: 20, width: 640, height: 480 },
  id: "browser:browser-1",
  isMinimized: false,
  kind: "browser",
  restoreFrame: null,
  title: "Browser"
};

test("readWorkbenchHostExternalState returns null state without a source", () => {
  assert.deepEqual(
    readWorkbenchHostExternalState({
      node,
      workspaceId: "workspace-1"
    }),
    {
      externalNodeState: null,
      externalWorkspaceState: null
    }
  );
});

test("readWorkbenchHostExternalState looks up state using the final node identity", () => {
  const nodeLookups: WorkbenchHostExternalStateLookupInput[] = [];
  const workspaceLookups: Array<{ workspaceId: string }> = [];
  const externalNodeState = { url: "https://example.com" };
  const externalWorkspaceState = { selectedTemplateId: "template-1" };

  assert.deepEqual(
    readWorkbenchHostExternalState({
      externalStateSource: {
        getNodeState(input) {
          nodeLookups.push(input);
          return externalNodeState;
        },
        getWorkspaceState(input) {
          workspaceLookups.push(input);
          return externalWorkspaceState;
        }
      },
      node,
      workspaceId: "workspace-1"
    }),
    {
      externalNodeState,
      externalWorkspaceState
    }
  );
  assert.deepEqual(nodeLookups, [
    {
      instanceId: "browser-1",
      instanceKey: "https://example.com",
      nodeId: "browser:browser-1",
      typeId: "browser",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(workspaceLookups, [{ workspaceId: "workspace-1" }]);
});

test("readWorkbenchHostExternalState falls back to restored snapshot node state", () => {
  const restoredNode = {
    ...node,
    data: {
      ...node.data,
      snapshotNodeState: { activePaneId: "preview" }
    }
  };

  assert.deepEqual(
    readWorkbenchHostExternalState({
      externalStateSource: {
        getNodeState() {
          return null;
        },
        getWorkspaceState() {
          return null;
        }
      },
      node: restoredNode,
      workspaceId: "workspace-1"
    }),
    {
      externalNodeState: { activePaneId: "preview" },
      externalWorkspaceState: null
    }
  );
});
