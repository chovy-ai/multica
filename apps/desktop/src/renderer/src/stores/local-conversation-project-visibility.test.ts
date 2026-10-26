// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createProjectVisibilityStore, projectVisibilityScopeKey } from "./local-conversation-project-visibility";

const scope = { userId: "user", workspaceId: "workspace" };
function setup() {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
  return { storage, entries, store: createProjectVisibilityStore(storage) };
}

describe("local conversation project visibility", () => {
  it("persists removal and restoration independently for each account and workspace", () => {
    const { store, storage } = setup();
    store.getState().setProjectHidden(scope, "project", true);
    store.getState().setProjectHidden(scope, "project", true);
    const reopened = createProjectVisibilityStore(storage);
    expect(reopened.getState().hiddenByScope[projectVisibilityScopeKey(scope)]).toEqual(["project"]);
    expect(reopened.getState().hiddenByScope[projectVisibilityScopeKey({ ...scope, userId: "other-user" })]).toBeUndefined();
    expect(reopened.getState().hiddenByScope[projectVisibilityScopeKey({ ...scope, workspaceId: "other-workspace" })]).toBeUndefined();
    reopened.getState().setProjectHidden({ ...scope, workspaceId: "other-workspace" }, "project", true);
    reopened.getState().setProjectHidden(scope, "project", false);
    const restored = createProjectVisibilityStore(storage).getState();
    expect(restored.hiddenByScope[projectVisibilityScopeKey(scope)]).toEqual([]);
    expect(restored.hiddenByScope[projectVisibilityScopeKey({ ...scope, workspaceId: "other-workspace" })]).toEqual(["project"]);
  });
  it("ignores malformed saved preferences without losing valid scopes", () => {
    const { storage, entries } = setup();
    entries.set("multica_local_conversation_project_visibility", JSON.stringify({ state: { hiddenByScope: { valid: ["project"], invalid: "project", mixed: [null] } }, version: 0 }));
    expect(createProjectVisibilityStore(storage).getState().hiddenByScope).toEqual({ valid: ["project"] });
  });
});
