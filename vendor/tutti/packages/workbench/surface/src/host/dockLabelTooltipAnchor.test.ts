import assert from "node:assert/strict";
import test from "node:test";
import { resolveDockLabelTooltipAnchorRect } from "./dockLabelTooltipAnchor.ts";

function rect({
  height,
  left,
  top,
  width
}: {
  height: number;
  left: number;
  top: number;
  width: number;
}): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({})
  };
}

test("dock label tooltip anchors to the transformed icon bounds", () => {
  const slotRect = rect({ height: 74, left: 20, top: 40, width: 74 });
  const visualRect = rect({ height: 74, left: 20, top: 40, width: 74 });
  const slotElement = {
    getBoundingClientRect: () => slotRect,
    querySelector: () => ({ getBoundingClientRect: () => visualRect })
  } as unknown as HTMLElement;

  assert.deepEqual(resolveDockLabelTooltipAnchorRect(slotElement), {
    height: 74,
    left: 20,
    top: 40,
    width: 74
  });
});

test("dock label tooltip falls back to the slot bounds", () => {
  const slotRect = rect({ height: 43.2, left: 20, top: 40, width: 43.2 });
  const slotElement = {
    getBoundingClientRect: () => slotRect,
    querySelector: () => null
  } as unknown as HTMLElement;

  assert.deepEqual(resolveDockLabelTooltipAnchorRect(slotElement), {
    height: 43.2,
    left: 20,
    top: 40,
    width: 43.2
  });
});
