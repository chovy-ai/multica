// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createProjectExpansionStore, projectExpansionScopeKey } from "./local-conversation-project-expansion";

const scope = { userId: "user", workspaceId: "workspace" };

describe("local conversation project expansion", () => {
  it("isolates choices by account, workspace and device", () => {
    const store = createProjectExpansionStore();
    const otherUser = { ...scope, userId: "other-user" };
    const otherWorkspace = { ...scope, workspaceId: "other-workspace" };
    const collapsed = (value = scope, deviceId = "local") =>
      store.getState().collapsedByScope[projectExpansionScopeKey(value, deviceId)] ?? [];

    store.getState().setProjectCollapsed(scope, "local", "project", true);
    expect(collapsed()).toEqual(["project"]);
    expect(collapsed(otherUser)).toEqual([]);
    expect(collapsed(otherWorkspace)).toEqual([]);
    expect(collapsed(scope, "peer-1")).toEqual([]);

    store.getState().setProjectCollapsed(otherUser, "local", "project", true);
    store.getState().setProjectCollapsed(otherWorkspace, "local", "project", true);
    store.getState().setProjectCollapsed(scope, "peer-1", "project", true);
    store.getState().setProjectCollapsed(scope, "local", "project", false);
    expect(collapsed()).toEqual([]);
    expect(collapsed(otherUser)).toEqual(["project"]);
    expect(collapsed(otherWorkspace)).toEqual(["project"]);
    expect(collapsed(scope, "peer-1")).toEqual(["project"]);
  });

  it("starts expanded in a fresh renderer store", () => {
    const store = createProjectExpansionStore();
    store.getState().setProjectCollapsed(scope, "local", "project", true);
    expect(createProjectExpansionStore().getState().collapsedByScope).toEqual({});
  });

  it("does not notify subscribers when an explicit expansion is already applied", () => {
    const store = createProjectExpansionStore();
    store.getState().setProjectCollapsed(scope, "local", "project", false);
    const initial = store.getState();
    expect(initial.collapsedByScope).toEqual({});
    store.getState().setProjectCollapsed(scope, "local", "project", true);
    const collapsed = store.getState();
    store.getState().setProjectCollapsed(scope, "local", "project", true);
    expect(store.getState()).toBe(collapsed);
    store.getState().setProjectCollapsed(scope, "local", "project", false);
    const expanded = store.getState();
    store.getState().setProjectCollapsed(scope, "local", "project", false);
    expect(store.getState()).toBe(expanded);
  });
});
