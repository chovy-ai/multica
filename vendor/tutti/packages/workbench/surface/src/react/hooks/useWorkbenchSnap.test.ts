import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkbenchActiveSnapTarget } from "./workbenchSnapTarget.ts";

test("keeps legacy top snapping when edge snapping is disabled", () => {
  assert.equal(resolveWorkbenchActiveSnapTarget("top"), "top");
  assert.equal(resolveWorkbenchActiveSnapTarget("top-left"), "top");
  assert.equal(resolveWorkbenchActiveSnapTarget("top-right"), "top");
  assert.equal(resolveWorkbenchActiveSnapTarget("left"), null);
  assert.equal(resolveWorkbenchActiveSnapTarget("bottom-right"), null);
});

test("keeps edge and corner targets when edge snapping is enabled", () => {
  assert.equal(
    resolveWorkbenchActiveSnapTarget("top-left", { edgeSnapEnabled: true }),
    "top-left"
  );
  assert.equal(
    resolveWorkbenchActiveSnapTarget("bottom-right", { edgeSnapEnabled: true }),
    "bottom-right"
  );
});
