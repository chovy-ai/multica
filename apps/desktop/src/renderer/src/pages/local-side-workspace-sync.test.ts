import { beforeEach, describe, expect, it } from "vitest";
import { applySideCommand, hasSideWorkspaceView, readSideLayout, registerSideWorkspaceView, sideLayoutKey, sideSnapshot, type SideLayout } from "./local-side-workspace-sync";
const scope = { userId: "user", workspaceId: "workspace" };
beforeEach(() => localStorage.clear());
describe("Side layout transport", () => {
  it("retains focus when collapsed, advances revisions after reload, and transports file selection", () => {
    const layout: SideLayout = { open: false, selected: "file:one", tabs: [{ id: "file:one", kind: "file", location: { root: "/tmp", path: "/tmp", kind: "directory", name: "tmp" }, selected: { root: "/tmp", path: "/tmp/a.ts", name: "a.ts", kind: "file" }, line: 42 }] };
    const first = sideSnapshot("main", layout, true), next = sideSnapshot("main", layout, false);
    expect(next.revision).toBeGreaterThan(first.revision); expect(first).toMatchObject({ panelOpen: false, selectedTabId: "file:one", tabs: [{ selectedPath: "/tmp/a.ts", line: 42 }] });
  });
  it("closes only this turn's temporary agent pages and preserves user/deliverable pages", () => {
    const layout: SideLayout = { open: true, selected: "agent", tabs: [
      { id: "user", kind: "web", url: "https://example.test" },
      { id: "agent", kind: "web", url: "https://example.test/temp", openedBy: "agent", turnId: "turn" },
      { id: "kept", kind: "web", url: "https://example.test/keep", openedBy: "agent", turnId: "turn", keep: true },
      { id: "other", kind: "web", url: "https://example.test/other", openedBy: "agent", turnId: "other-turn" },
    ] };
    const request = { op: "release" as const, scope, conversationId: "main", turnId: "turn" };
    expect(applySideCommand(layout, request).layout.tabs.map((tab) => tab.id)).toEqual(["user", "kept", "other"]);
    expect(() => applySideCommand(layout, { ...request, op: "close", tabId: "user" })).toThrow("User tabs");
  });
  it("never replaces a user's ownership when opening an existing URL", () => {
    const layout: SideLayout = { open: false, selected: "user", tabs: [{ id: "user", kind: "web", url: "https://example.test/" }] };
    const { layout: updated, tabId } = applySideCommand(layout, { op: "open", scope, conversationId: "main", turnId: "turn" }, { id: "agent", kind: "web", url: "https://example.test/", openedBy: "agent", turnId: "turn" });
    expect(tabId).toBe("user"); expect(updated.tabs[0]).not.toHaveProperty("openedBy");
  });
  it("tracks only mounted views and restores saved layouts with account/workspace namespaces", () => {
    const key = sideLayoutKey(scope, "main"); localStorage.setItem(key, JSON.stringify({ tabs: [{ id: "side:one", kind: "side", sessionId: "side" }], selected: "missing", open: true }));
    expect(readSideLayout(key).selected).toBe("side:one");
    expect(readSideLayout(sideLayoutKey({ ...scope, userId: "other" }, "main")).tabs).toEqual([]);
    const unmount = registerSideWorkspaceView(scope); expect(hasSideWorkspaceView(scope)).toBe(true); unmount(); expect(hasSideWorkspaceView(scope)).toBe(false);
  });
});
