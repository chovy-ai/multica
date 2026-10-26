import assert from "node:assert/strict";
import test from "node:test";
import {
  focusWorkbenchStack,
  normalizeWorkbenchStack,
  orderWorkbenchNodesForRender,
  removeFromWorkbenchStack
} from "./stack.ts";
import type { WorkbenchNode } from "./types.ts";

const nodes: WorkbenchNode[] = [makeNode("a"), makeNode("b"), makeNode("c")];

test("normalizes stack to known node ids", () => {
  assert.deepEqual(normalizeWorkbenchStack(nodes, ["b", "missing", "b"]), [
    "b",
    "a",
    "c"
  ]);
});

test("focuses and removes stack ids", () => {
  assert.deepEqual(focusWorkbenchStack(["a", "b"], "a"), ["b", "a"]);
  assert.deepEqual(removeFromWorkbenchStack(["a", "b"], "a"), ["b"]);
});

test("orders nodes for render by stack", () => {
  assert.deepEqual(
    orderWorkbenchNodesForRender(nodes, ["c", "a", "b"]).map((node) => node.id),
    ["c", "a", "b"]
  );
});

function makeNode(id: string): WorkbenchNode {
  return {
    id,
    kind: "test",
    title: id,
    frame: { x: 0, y: 0, width: 240, height: 180 },
    displayMode: "floating",
    restoreFrame: null,
    isMinimized: false,
    data: null
  };
}
