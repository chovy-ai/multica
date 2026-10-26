import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorkspaceFileOpenWithCacheKey,
  WorkspaceFileOpenWithApplicationsCache
} from "./openWithApplicationsCache.ts";

test("open with cache key groups files by extension and kind", () => {
  assert.equal(
    resolveWorkspaceFileOpenWithCacheKey({
      kind: "file",
      name: "config.json",
      path: "/workspace/config.json"
    }),
    "file:json"
  );
  assert.equal(
    resolveWorkspaceFileOpenWithCacheKey({
      kind: "file",
      name: "data.json",
      path: "/workspace/other/data.json"
    }),
    "file:json"
  );
});

test("open with cache reuses resolved applications for the same key", async () => {
  const cache = new WorkspaceFileOpenWithApplicationsCache();
  let loadCount = 0;

  const first = await cache.resolve("file:json", async () => {
    loadCount += 1;
    return [
      {
        applicationPath: "/Applications/Visual Studio Code.app",
        iconDataUrl: null,
        name: "Visual Studio Code"
      }
    ];
  });
  const second = await cache.resolve("file:json", async () => {
    loadCount += 1;
    return [];
  });

  assert.equal(loadCount, 1);
  assert.deepEqual(second, first);
});

test("open with cache schedules warmup once per extension", async () => {
  const cache = new WorkspaceFileOpenWithApplicationsCache();
  let loadCount = 0;

  cache.scheduleWarmup(
    [
      {
        hasChildren: false,
        kind: "file",
        mtimeMs: null,
        name: "a.json",
        path: "/workspace/a.json",
        sizeBytes: 1
      },
      {
        hasChildren: false,
        kind: "file",
        mtimeMs: null,
        name: "b.json",
        path: "/workspace/b.json",
        sizeBytes: 1
      },
      {
        hasChildren: false,
        kind: "file",
        mtimeMs: null,
        name: "c.ts",
        path: "/workspace/c.ts",
        sizeBytes: 1
      }
    ],
    async () => {
      loadCount += 1;
      return [];
    }
  );

  await flushMicrotasks();
  assert.equal(loadCount, 2);
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
