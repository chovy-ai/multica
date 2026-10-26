import assert from "node:assert/strict";
import test from "node:test";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createWorkspaceFileManagerI18nRuntime,
  createWorkspaceFileManagerService,
  workspaceFileManagerI18nResources
} from "./index.ts";
import type {
  WorkspaceFileDirectoryListing,
  WorkspaceFileManagerHost
} from "./index.ts";

test("revealPath loads the parent directory and selects the target file", async () => {
  const listedPaths: string[] = [];
  const host: WorkspaceFileManagerHost = {
    async listDirectory(input): Promise<WorkspaceFileDirectoryListing> {
      listedPaths.push(input.path);
      return {
        directoryPath: input.path,
        entries: [
          {
            hasChildren: false,
            kind: "file",
            mtimeMs: null,
            name: "App.tsx",
            path: "/Users/demo/project/src/App.tsx",
            sizeBytes: 42
          }
        ],
        root: "/Users/demo/project",
        workspaceID: input.workspaceID
      };
    }
  };

  const service = createWorkspaceFileManagerService();
  const session = service.createSession({
    i18n: createWorkspaceFileManagerI18nRuntime(
      createI18nRuntime({
        dictionaries: [workspaceFileManagerI18nResources.en]
      })
    ),
    host,
    initialDirectoryPath: "/Users/demo/project",
    workspaceID: "workspace-1"
  });
  session.store.root = "/Users/demo/project";

  await session.revealPath("/Users/demo/project/src/App.tsx");

  assert.deepEqual(listedPaths, ["/Users/demo/project/src"]);
  assert.equal(session.store.currentDirectoryPath, "/Users/demo/project/src");
  assert.equal(session.store.selectedPath, "/Users/demo/project/src/App.tsx");
});
