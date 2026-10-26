import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkbenchShortcutIntent } from "./workbenchShortcutIntent.ts";

test("resolves app-scoped workbench snap shortcuts", () => {
  assert.deepEqual(
    resolveWorkbenchShortcutIntent(
      {
        key: "ArrowLeft",
        metaKey: true
      },
      { windowManagementShortcutPreset: "commandArrows" }
    ),
    { type: "applyFocusedSnapTarget", snapTarget: "left" }
  );
  assert.deepEqual(
    resolveWorkbenchShortcutIntent(
      {
        key: "ArrowRight",
        metaKey: true
      },
      { windowManagementShortcutPreset: "commandArrows" }
    ),
    { type: "applyFocusedSnapTarget", snapTarget: "right" }
  );
});

test("resolves vertical workbench shortcuts as half-height quick layouts", () => {
  assert.deepEqual(
    resolveWorkbenchShortcutIntent(
      {
        key: "ArrowUp",
        metaKey: true
      },
      { windowManagementShortcutPreset: "commandArrows" }
    ),
    { type: "applyFocusedQuickLayout", target: "top" }
  );
  assert.deepEqual(
    resolveWorkbenchShortcutIntent(
      {
        key: "ArrowDown",
        metaKey: true
      },
      { windowManagementShortcutPreset: "commandArrows" }
    ),
    { type: "applyFocusedQuickLayout", target: "bottom" }
  );
});

test("resolves visible layout reset shortcut", () => {
  assert.deepEqual(
    resolveWorkbenchShortcutIntent(
      {
        key: "0",
        metaKey: true
      },
      { windowManagementShortcutPreset: "commandArrows" }
    ),
    {
      type: "applyVisibleLayoutPreset",
      preset: { kind: "balanced" }
    }
  );
});

test("does not resolve shortcuts while editing text", () => {
  assert.equal(
    resolveWorkbenchShortcutIntent(
      {
        key: "ArrowLeft",
        metaKey: true,
        target: { tagName: "input" } as unknown as EventTarget
      },
      { windowManagementShortcutPreset: "commandArrows" }
    ),
    null
  );
  assert.equal(
    resolveWorkbenchShortcutIntent({
      key: "Escape",
      target: { isContentEditable: true } as unknown as EventTarget
    }),
    null
  );
});

test("does not resolve shift-modified or already-handled shortcuts", () => {
  assert.equal(
    resolveWorkbenchShortcutIntent(
      {
        key: "ArrowLeft",
        metaKey: true,
        shiftKey: true
      },
      { windowManagementShortcutPreset: "commandArrows" }
    ),
    null
  );
  assert.equal(
    resolveWorkbenchShortcutIntent(
      {
        key: "ArrowLeft",
        defaultPrevented: true,
        metaKey: true
      },
      { windowManagementShortcutPreset: "commandArrows" }
    ),
    null
  );
});

test("requires an enabled window management shortcut preset for snap shortcuts", () => {
  assert.equal(
    resolveWorkbenchShortcutIntent({
      key: "ArrowLeft",
      metaKey: true
    }),
    null
  );
  assert.deepEqual(
    resolveWorkbenchShortcutIntent(
      {
        key: "ArrowLeft",
        metaKey: true,
        shiftKey: true
      },
      { windowManagementShortcutPreset: "commandShiftArrows" }
    ),
    { type: "applyFocusedSnapTarget", snapTarget: "left" }
  );
});
