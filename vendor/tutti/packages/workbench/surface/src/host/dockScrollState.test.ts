import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkbenchHostDockScrollState } from "./dockScrollState.ts";

test("dock scroll state stays disabled when the viewport can fit all items", () => {
  assert.deepEqual(
    resolveWorkbenchHostDockScrollState({
      contentSize: 640,
      scrollOffset: 0,
      scrollSize: 684,
      viewportSize: 640
    }),
    {
      canScrollBackward: false,
      canScrollForward: false,
      hasOverflow: false
    }
  );
});

test("dock scroll state enables forward scrolling when items exceed the viewport", () => {
  assert.deepEqual(
    resolveWorkbenchHostDockScrollState({
      contentSize: 720,
      scrollOffset: 0,
      scrollSize: 764,
      viewportSize: 640
    }),
    {
      canScrollBackward: false,
      canScrollForward: true,
      hasOverflow: true
    }
  );
});

test("dock scroll state hides the forward button at the end edge", () => {
  assert.deepEqual(
    resolveWorkbenchHostDockScrollState({
      contentSize: 720,
      scrollOffset: 124,
      scrollSize: 764,
      viewportSize: 640
    }),
    {
      canScrollBackward: true,
      canScrollForward: false,
      hasOverflow: true
    }
  );
});
