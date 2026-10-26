import assert from "node:assert/strict";
import test from "node:test";
import { resolveComposedInputValueSync } from "./useComposedInputValue.ts";

test("composed input sync keeps the local value while IME composition is active", () => {
  assert.deepEqual(
    resolveComposedInputValueSync({
      isComposing: true,
      localValue: "ab中",
      pendingCommit: null,
      value: "ab"
    }),
    {
      pendingCommit: null,
      shouldSyncLocalValue: false,
      value: "ab中"
    }
  );
});

test("composed input sync ignores stale parent values after a local IME commit", () => {
  assert.deepEqual(
    resolveComposedInputValueSync({
      isComposing: false,
      localValue: "ab中文cd",
      pendingCommit: {
        committedValue: "ab中文cd",
        previousValue: "abcd"
      },
      value: "abcd"
    }),
    {
      pendingCommit: {
        committedValue: "ab中文cd",
        previousValue: "abcd"
      },
      shouldSyncLocalValue: false,
      value: "ab中文cd"
    }
  );
});

test("composed input sync clears a pending commit after the parent catches up", () => {
  assert.deepEqual(
    resolveComposedInputValueSync({
      isComposing: false,
      localValue: "ab中文cd",
      pendingCommit: {
        committedValue: "ab中文cd",
        previousValue: "abcd"
      },
      value: "ab中文cd"
    }),
    {
      pendingCommit: null,
      shouldSyncLocalValue: false,
      value: "ab中文cd"
    }
  );
});

test("composed input sync keeps a later local commit while the parent is still stale", () => {
  assert.deepEqual(
    resolveComposedInputValueSync({
      isComposing: false,
      localValue: "ab中文cde",
      pendingCommit: {
        committedValue: "ab中文cde",
        previousValue: "abcd"
      },
      value: "abcd"
    }),
    {
      pendingCommit: {
        committedValue: "ab中文cde",
        previousValue: "abcd"
      },
      shouldSyncLocalValue: false,
      value: "ab中文cde"
    }
  );
});

test("composed input sync still accepts external value changes without a pending commit", () => {
  assert.deepEqual(
    resolveComposedInputValueSync({
      isComposing: false,
      localValue: "Draft",
      pendingCommit: null,
      value: ""
    }),
    {
      pendingCommit: null,
      shouldSyncLocalValue: true,
      value: ""
    }
  );
});

test("composed input sync accepts external changes after a local commit", () => {
  assert.deepEqual(
    resolveComposedInputValueSync({
      isComposing: false,
      localValue: "ab中文cd",
      pendingCommit: {
        committedValue: "ab中文cd",
        previousValue: "abcd"
      },
      value: "external reset"
    }),
    {
      pendingCommit: null,
      shouldSyncLocalValue: true,
      value: "external reset"
    }
  );
});
