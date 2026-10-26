import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchNode } from "../core/types.ts";
import {
  orderWorkbenchNodesForMissionControl,
  resolveWorkbenchMissionControlPreviewLayout
} from "./layout.ts";

test("orders mission control nodes by their workspace position", () => {
  const ordered = orderWorkbenchNodesForMissionControl([
    makeNode("b", { x: 320, y: 44, width: 320, height: 220 }),
    makeNode("c", { x: 40, y: 210, width: 420, height: 260 }),
    makeNode("a", { x: 40, y: 40, width: 320, height: 220 })
  ]);

  assert.deepEqual(
    ordered.map((node) => node.id),
    ["a", "b", "c"]
  );
});

test("packs mission control previews into a centered justified grid", () => {
  const layout = resolveWorkbenchMissionControlPreviewLayout({
    container: { x: 20, y: 40, width: 960, height: 540 },
    nodes: [
      makeNode("a", { x: 40, y: 40, width: 640, height: 360 }),
      makeNode("b", { x: 760, y: 40, width: 480, height: 360 }),
      makeNode("c", { x: 40, y: 420, width: 420, height: 320 })
    ]
  });

  assert.equal(layout.length, 3);
  assert.ok(layout.every((item) => item.frame.width > 0));
  assert.ok(layout.every((item) => item.frame.height > 0));
  assert.ok(layout[0]!.frame.y <= layout[2]!.frame.y);
  assert.ok(layout[0]!.frame.x < layout[1]!.frame.x);
});

test("preserves relative node sizes while fitting previews on screen", () => {
  const layout = resolveWorkbenchMissionControlPreviewLayout({
    container: { x: 0, y: 0, width: 1200, height: 700 },
    nodes: [
      makeNode("large", { x: 0, y: 0, width: 1200, height: 800 }),
      makeNode("medium", { x: 1240, y: 0, width: 900, height: 600 }),
      makeNode("small", { x: 0, y: 860, width: 480, height: 320 })
    ]
  });

  assert.equal(layout.length, 3);
  assert.ok(layout.every((item) => item.frame.x >= 0));
  assert.ok(layout.every((item) => item.frame.y >= 0));
  assert.ok(layout.every((item) => item.frame.x + item.frame.width <= 1200));
  assert.ok(layout.every((item) => item.frame.y + item.frame.height <= 700));
  assert.ok(layout[0]!.frame.width > layout[1]!.frame.width);
  assert.ok(layout[1]!.frame.width > layout[2]!.frame.width);
  assert.ok(layout[0]!.frame.height > layout[1]!.frame.height);
  assert.ok(layout[1]!.frame.height > layout[2]!.frame.height);
});

function makeNode(id: string, frame: WorkbenchNode["frame"]): WorkbenchNode {
  return {
    id,
    kind: "test",
    title: id,
    frame,
    displayMode: "floating",
    restoreFrame: null,
    isMinimized: false,
    data: null
  };
}
