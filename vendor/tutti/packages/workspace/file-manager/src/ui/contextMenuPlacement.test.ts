import assert from "node:assert/strict";
import test from "node:test";
import {
  clampContextMenuPosition,
  estimateOpenWithSubmenuHeight,
  resolveOpenWithSubmenuPlacement,
  shouldShowOpenWithSectionDivider
} from "./contextMenuPlacement.ts";

test("clampContextMenuPosition keeps menus inside the boundary", () => {
  assert.deepEqual(
    clampContextMenuPosition({
      boundaryHeight: 400,
      boundaryWidth: 300,
      menuHeight: 120,
      menuWidth: 220,
      x: 12,
      y: 24
    }),
    { x: 12, y: 24 }
  );

  assert.deepEqual(
    clampContextMenuPosition({
      boundaryHeight: 400,
      boundaryWidth: 300,
      menuHeight: 120,
      menuWidth: 220,
      x: 200,
      y: 360
    }),
    { x: 72, y: 272 }
  );
});

test("estimateOpenWithSubmenuHeight scales with submenu sections", () => {
  assert.equal(
    estimateOpenWithSubmenuHeight({
      applicationCount: 0,
      isLoading: false,
      showExternalSection: false,
      showOpenInAppBrowser: false,
      showOpenInDefaultBrowser: false,
      showOpenWithOther: false
    }),
    16
  );

  assert.equal(
    estimateOpenWithSubmenuHeight({
      applicationCount: 6,
      isLoading: true,
      showExternalSection: true,
      showOpenInAppBrowser: true,
      showOpenInDefaultBrowser: true,
      showOpenWithOther: true
    }),
    400
  );

  assert.equal(
    estimateOpenWithSubmenuHeight({
      applicationCount: 3,
      isLoading: false,
      showExternalSection: true,
      showOpenInAppBrowser: false,
      showOpenInDefaultBrowser: true,
      showOpenInFileViewer: false,
      showOpenWithOther: true
    }),
    208
  );
});

test("open with section divider requires both internal and external actions", () => {
  assert.equal(
    shouldShowOpenWithSectionDivider({
      showExternalSection: true,
      showOpenInAppBrowser: false,
      showOpenInFileViewer: false
    }),
    false
  );
  assert.equal(
    shouldShowOpenWithSectionDivider({
      showExternalSection: true,
      showOpenInAppBrowser: true,
      showOpenInFileViewer: false
    }),
    true
  );
});

test("open with submenu prefers the trigger's right side when it fits", () => {
  assert.deepEqual(
    resolveOpenWithSubmenuPlacement({
      parentMenuLeft: 180,
      parentMenuTop: 80,
      submenuHeight: 240,
      triggerLeft: 180,
      triggerRight: 400,
      triggerTop: 112,
      viewportHeight: 720,
      viewportWidth: 1_000
    }),
    { left: 404, mode: "right", top: 112, width: 220 }
  );
});

test("open with submenu flips left when only the trigger's left side fits", () => {
  assert.deepEqual(
    resolveOpenWithSubmenuPlacement({
      parentMenuLeft: 400,
      parentMenuTop: 80,
      submenuHeight: 240,
      triggerLeft: 400,
      triggerRight: 620,
      triggerTop: 112,
      viewportHeight: 720,
      viewportWidth: 640
    }),
    { left: 176, mode: "left", top: 112, width: 220 }
  );
});

test("open with submenu overlays the parent when neither side fits", () => {
  assert.deepEqual(
    resolveOpenWithSubmenuPlacement({
      parentMenuLeft: 84,
      parentMenuTop: 52,
      submenuHeight: 240,
      triggerLeft: 84,
      triggerRight: 304,
      triggerTop: 84,
      viewportHeight: 500,
      viewportWidth: 360
    }),
    { left: 84, mode: "overlay", top: 52, width: 220 }
  );
});

test("open with submenu remains padded in short and very narrow viewports", () => {
  assert.deepEqual(
    resolveOpenWithSubmenuPlacement({
      parentMenuLeft: 90,
      parentMenuTop: 300,
      submenuHeight: 300,
      triggerLeft: 90,
      triggerRight: 310,
      triggerTop: 332,
      viewportHeight: 360,
      viewportWidth: 200
    }),
    { left: 12, mode: "overlay", top: 16, width: 176 }
  );
});
