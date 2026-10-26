import assert from "node:assert/strict";
import test from "node:test";
import { shouldTrackDirectoryExpanded } from "./workspaceFileManagerAnalytics.ts";

test("tracks directory expansion when target directory changes", () => {
  assert.equal(
    shouldTrackDirectoryExpanded({
      currentDirectoryPath: "/Users/demo",
      nextDirectoryPath: "/Users/demo/Desktop"
    }),
    true
  );
});

test("does not track directory expansion when reloading the current directory", () => {
  assert.equal(
    shouldTrackDirectoryExpanded({
      currentDirectoryPath: "/Users/demo",
      nextDirectoryPath: "/Users/demo/"
    }),
    false
  );
});
