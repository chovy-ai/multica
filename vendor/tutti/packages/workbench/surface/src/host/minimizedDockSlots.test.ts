import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchNode } from "../core/types.ts";
import {
  resolveWorkbenchMinimizedDockAnchorKeyForNode,
  resolveWorkbenchMinimizedDockSlots,
  workbenchMinimizedDockStackAnchorKey
} from "./minimizedDockSlots.ts";
import type {
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition
} from "./types.ts";

test("orders minimized dock nodes by persisted minimize time and stacks overflow", () => {
  const slots = resolveWorkbenchMinimizedDockSlots({
    nodeDefinitions: new Map([
      [
        "textFile",
        {
          window: {
            minimizedDock: {
              kind: "snapshot"
            }
          }
        } as WorkbenchHostNodeDefinition
      ]
    ]),
    nodes: [
      makeNode("a", 100),
      makeNode("b", 600),
      makeNode("c", 500),
      makeNode("d", 400),
      makeNode("e", 300),
      makeNode("f", 200)
    ]
  });

  assert.deepEqual(
    slots.map((slot) =>
      slot.kind === "node" ? slot.node.id : slot.nodes.map((node) => node.id)
    ),
    ["b", "c", "d", "e", ["f", "a"]]
  );
  assert.equal(slots[4]?.anchorKey, workbenchMinimizedDockStackAnchorKey);
  assert.equal(
    resolveWorkbenchMinimizedDockAnchorKeyForNode({
      nodeId: "a",
      slots
    }),
    workbenchMinimizedDockStackAnchorKey
  );
});

test("component minimized previews reuse minimized dock slot ordering", () => {
  const slots = resolveWorkbenchMinimizedDockSlots({
    nodeDefinitions: new Map([
      [
        "agentGui",
        {
          window: {
            minimizedDock: {
              kind: "component",
              providePreview: () => ({
                element: null,
                kind: "component"
              })
            }
          }
        } as unknown as WorkbenchHostNodeDefinition
      ]
    ]),
    nodes: [makeNode("a", 100, "agentGui"), makeNode("b", 200, "agentGui")]
  });

  assert.deepEqual(
    slots.map((slot) => (slot.kind === "node" ? slot.node.id : "stack")),
    ["b", "a"]
  );
  assert.equal(
    resolveWorkbenchMinimizedDockAnchorKeyForNode({
      nodeId: "b",
      slots
    }),
    "minimized:b"
  );
});

function makeNode(
  id: string,
  minimizedAtUnixMs: number,
  typeId = "textFile"
): WorkbenchNode<WorkbenchHostNodeData> {
  return {
    id,
    kind: "workspaceFile",
    title: id,
    frame: { x: 0, y: 0, width: 320, height: 240 },
    displayMode: "floating",
    restoreFrame: null,
    isMinimized: true,
    minimizedAtUnixMs,
    data: {
      instanceId: id,
      typeId
    }
  };
}
