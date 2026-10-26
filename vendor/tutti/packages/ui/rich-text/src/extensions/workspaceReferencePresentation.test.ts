import assert from "node:assert/strict";
import test from "node:test";
import { getWorkspaceReferencePresentation } from "./workspaceReferencePresentation.ts";

test("prefers the label and preserves the full path for tooltip content", () => {
  assert.deepEqual(
    getWorkspaceReferencePresentation(
      "1ef8ef95-684f-483c-9a80-37b47c9442be",
      "/workspace/Downloads/foo/bar/template-bootstrap/1ef8ef95-684f-483c-9a80-37b47c9442be/"
    ),
    {
      displayLabel: "1ef8ef95-684f-483c-9a80-37b47c9442be",
      fullPath:
        "/workspace/Downloads/foo/bar/template-bootstrap/1ef8ef95-684f-483c-9a80-37b47c9442be"
    }
  );
});

test("keeps the label when it matches the final path segment", () => {
  assert.deepEqual(
    getWorkspaceReferencePresentation(
      "Applications",
      "/workspace/Applications/"
    ),
    {
      displayLabel: "Applications",
      fullPath: "/workspace/Applications"
    }
  );
});

test("falls back to the path basename when the label is empty", () => {
  assert.deepEqual(
    getWorkspaceReferencePresentation("", "/workspace/docs/README.md"),
    {
      displayLabel: "README.md",
      fullPath: "/workspace/docs/README.md"
    }
  );
});

test("normalizes trailing separators for the tooltip path", () => {
  assert.deepEqual(
    getWorkspaceReferencePresentation("garble", "/workspace/go/bin/garble"),
    {
      displayLabel: "garble",
      fullPath: "/workspace/go/bin/garble"
    }
  );
});

test("supports windows-style paths", () => {
  assert.deepEqual(
    getWorkspaceReferencePresentation(
      "notes.txt",
      "C:\\Users\\alice\\Documents\\work\\notes.txt"
    ),
    {
      displayLabel: "notes.txt",
      fullPath: "C:\\Users\\alice\\Documents\\work\\notes.txt"
    }
  );
});
