import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SideWorkspaceCommand } from "../../../shared/side-workspace";
import { DesktopSideWorkspaceBridge } from "./side-workspace-bridge";
import { sideLayoutKey, type SideLayout } from "../pages/local-side-workspace-sync";
vi.mock("./local-v2-transport", () => ({ localV2Transport: () => window.desktopAPI.localV2 }));
const fake = vi.hoisted(() => ({ openTab: vi.fn(), navigateActiveSession: vi.fn() }));
vi.mock("@multica/core/auth", () => ({ useAuthStore: (selector: (value: unknown) => unknown) => selector({ user: { id: "user" }, status: "authenticated" }) }));
vi.mock("@multica/core/workspace", () => ({ useWorkspaceList: () => ({ workspaces: [{ id: "workspace", slug: "test" }], ready: true, unavailable: false }) }));
vi.mock("@multica/core/platform", () => ({ getCurrentWsId: () => "workspace", getCurrentSlug: () => "test" }));
vi.mock("../stores/tab-store", () => ({ useTabStore: Object.assign((selector: (value: unknown) => unknown) => selector({ activeWorkspaceSlug: "test" }), { getState: () => ({ openTab: fake.openTab, navigateActiveSession: fake.navigateActiveSession }) }) }));
const scope = { userId: "user", workspaceId: "workspace" };
let command: (value: SideWorkspaceCommand) => void;
let connection: (value: typeof scope, connected: boolean) => void;
let request: ReturnType<typeof vi.fn>;
/** Layouts the bridge recorded in the daemon. */
const synced = () => request.mock.calls.filter((call) => call[2].endsWith("/commands") && call[3].type === "side_workspace_sync").map((call) => call[3].workspace);
const ack = vi.fn(async () => {});
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  request = vi.fn(async (_scope, _method, path: string, body?: { workspace?: { revision: number } }) => {
    const snapshot = /^\/sessions\/([^/]+)\/snapshot$/.exec(path);
    if (snapshot) return { version: 2, store_generation: "g", snapshot_seq: 0, turns: [], conversation: { conversation_id: snapshot[1], summary_seq: 1, provider: "codex", title: "", status: "idle", pinned: false, archived: false, updated_at: "2026-10-29T00:00:00Z" } };
    return { revision: body?.workspace?.revision };
  });
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: {
    localV2: { request, send: vi.fn(), subscribe: () => () => {}, onConnection: (listener: typeof connection) => { connection = listener; return () => {}; } },
    sideWorkspace: { onCommand: (listener: typeof command) => { command = listener; return () => {}; }, ack, reconcile: vi.fn(async () => {}) },
  } });
});
afterEach(() => { cleanup(); localStorage.clear(); });
it("pushes saved layouts at application startup and daemon reconnect without mounting the chat page", async () => {
  const layout: SideLayout = { open: true, selected: "web:one", tabs: [{ id: "web:one", kind: "web", url: "https://example.test" }] };
  localStorage.setItem(sideLayoutKey(scope, "main"), JSON.stringify(layout));
  localStorage.setItem(sideLayoutKey({ ...scope, userId: "other" }, "foreign"), JSON.stringify(layout));
  render(<DesktopSideWorkspaceBridge />);
  await waitFor(() => expect(synced()).toContainEqual(expect.objectContaining({ conversationId: "main", visible: false })));
  expect(synced().some((layout) => layout.conversationId === "foreign")).toBe(false);
  request.mockClear(); act(() => connection(scope, true));
  await waitFor(() => expect(synced()).toContainEqual(expect.objectContaining({ conversationId: "main" })));
});
it("cleans temporary tabs when the chat page is unmounted and acknowledges the new snapshot", async () => {
  localStorage.setItem(sideLayoutKey(scope, "main"), JSON.stringify({ open: true, selected: "agent", tabs: [
    { id: "user", kind: "web", url: "https://example.test" }, { id: "agent", kind: "web", url: "https://example.test/temp", openedBy: "agent", turnId: "turn" },
  ] }));
  render(<DesktopSideWorkspaceBridge />);
  act(() => command({ id: "command", request: { op: "release", scope, conversationId: "main", turnId: "turn" } }));
  await waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({ id: "command", snapshot: expect.objectContaining({ tabs: [{ id: "user", kind: "web", url: "https://example.test" }] }) })));
  expect(JSON.parse(localStorage.getItem(sideLayoutKey(scope, "main"))!).tabs).toHaveLength(1);
  expect(fake.openTab).not.toHaveBeenCalled();
});

it("updates the selected conversation even when openTab reuses an older chat route", async () => {
  localStorage.setItem(sideLayoutKey(scope, "target"), JSON.stringify({ open: false, selected: "web:one", tabs: [{ id: "web:one", kind: "web", url: "https://example.test" }] }));
  render(<DesktopSideWorkspaceBridge />);
  act(() => command({ id: "focus", request: { op: "select", scope, conversationId: "target", turnId: "turn", tabId: "web:one" } }));
  await waitFor(() => expect(fake.navigateActiveSession).toHaveBeenCalledWith(expect.stringContaining("session=target"), { replace: true }));
  await waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({ id: "focus", tabId: "web:one" })));
});
