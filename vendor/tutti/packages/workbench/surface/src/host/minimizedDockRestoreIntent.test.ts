import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkbenchMinimizedDockRestoreIntent } from "./minimizedDockRestoreIntent.ts";
import type {
  WorkbenchMinimizedDockNode,
  WorkbenchMinimizedDockSlot
} from "./minimizedDockSlots.ts";

test("resolves an independent minimized dock node slot restore intent", () => {
  const intent = resolveWorkbenchMinimizedDockRestoreIntent({
    nodeId: "a",
    slots: [nodeSlot("a")],
    source: { anchorKey: "minimized:a", kind: "node-slot" }
  });

  assert.deepEqual(intent, {
    anchorKey: "minimized:a",
    kind: "node-slot",
    nodeId: "a"
  });
});

test("resolves a stack popup card restore intent without changing the stack anchor", () => {
  const intent = resolveWorkbenchMinimizedDockRestoreIntent({
    nodeId: "c",
    slots: [nodeSlot("a"), stackSlot(["b", "c"])],
    source: { kind: "stack-popup-card", stackAnchorKey: "minimized-stack" }
  });

  assert.deepEqual(intent, {
    anchorKey: "minimized-stack",
    kind: "stack-popup-card",
    nodeId: "c",
    stackAnchorKey: "minimized-stack"
  });
});

test("returns null when the requested node does not match the source slot", () => {
  assert.equal(
    resolveWorkbenchMinimizedDockRestoreIntent({
      nodeId: "missing",
      slots: [nodeSlot("a"), stackSlot(["b"])],
      source: { anchorKey: "minimized:a", kind: "node-slot" }
    }),
    null
  );
  assert.equal(
    resolveWorkbenchMinimizedDockRestoreIntent({
      nodeId: "a",
      slots: [nodeSlot("a"), stackSlot(["b"])],
      source: { kind: "stack-popup-card", stackAnchorKey: "minimized-stack" }
    }),
    null
  );
  assert.equal(
    resolveWorkbenchMinimizedDockRestoreIntent({
      nodeId: "b",
      slots: [nodeSlot("a"), stackSlot(["b"])],
      source: { anchorKey: "minimized-stack", kind: "node-slot" }
    }),
    null
  );
  assert.equal(
    resolveWorkbenchMinimizedDockRestoreIntent({
      nodeId: "b",
      slots: [nodeSlot("a"), stackSlot(["b"])],
      source: {
        kind: "stack-popup-card",
        stackAnchorKey: "unknown-stack"
      }
    }),
    null
  );
});

function nodeSlot(id: string): WorkbenchMinimizedDockSlot {
  return {
    anchorKey: `minimized:${id}`,
    kind: "node",
    node: createNode(id)
  };
}

function stackSlot(ids: readonly string[]): WorkbenchMinimizedDockSlot {
  return {
    anchorKey: "minimized-stack",
    kind: "stack",
    nodes: ids.map((id) => createNode(id))
  };
}

function createNode(id: string): WorkbenchMinimizedDockNode {
  return {
    data: {
      dockEntryId: id,
      instanceId: id,
      launchSource: "dock",
      typeId: "test"
    },
    displayMode: "floating",
    frame: { height: 480, width: 640, x: 0, y: 0 },
    id,
    isMinimized: true,
    kind: "test",
    minimizedAtUnixMs: 1,
    restoreFrame: null,
    title: id
  };
}
