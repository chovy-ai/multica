import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SideWorkspaceCommand } from "../../../shared/side-workspace";
import { LOCAL_CONVERSATION_METHODS, LOCAL_CONVERSATION_PROTOCOL_VERSION } from "@multica/core/local-conversation/protocol";
import { DesktopSideWorkspaceBridge } from "./side-workspace-bridge";
import { sideLayoutKey, type SideLayout } from "../pages/local-side-workspace-sync";
const fake = vi.hoisted(() => ({ openTab: vi.fn(), navigateActiveSession: vi.fn() }));
vi.mock("@multica/core/auth", () => ({ useAuthStore: (selector: (value: unknown) => unknown) => selector({ user: { id: "user" }, status: "authenticated" }) }));
vi.mock("@multica/core/workspace", () => ({ useWorkspaceList: () => ({ workspaces: [{ id: "workspace", slug: "test" }], ready: true, unavailable: false }) }));
vi.mock("@multica/core/platform", () => ({ getCurrentWsId: () => "workspace", getCurrentSlug: () => "test" }));
vi.mock("../stores/tab-store", () => ({ useTabStore: Object.assign((selector: (value: unknown) => unknown) => selector({ activeWorkspaceSlug: "test" }), { getState: () => ({ openTab: fake.openTab, navigateActiveSession: fake.navigateActiveSession }) }) }));
const scope = { userId: "user", workspaceId: "workspace" };
let command: (value: SideWorkspaceCommand) => void;
let availability: (value: unknown) => void;
let request: ReturnType<typeof vi.fn>;
const ack = vi.fn(async () => {});
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  request = vi.fn(async (_scope, method, params) => method === "capabilities" ? { protocolVersion: LOCAL_CONVERSATION_PROTOCOL_VERSION, methods: Object.keys(LOCAL_CONVERSATION_METHODS) } : method === "read" ? { id: params.id, provider: "codex" } : { revision: params.revision });
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: {
    localConversations: { request, subscribe: () => () => {} }, localHost: { subscribe: (listener: typeof availability) => { availability = listener; return () => {}; } },
    sideWorkspace: { onCommand: (listener: typeof command) => { command = listener; return () => {}; }, ack },
  } });
});
afterEach(() => { cleanup(); localStorage.clear(); });
it("pushes saved layouts at application startup and sidecar restart without mounting the chat page", async () => {
  const layout: SideLayout = { open: true, selected: "web:one", tabs: [{ id: "web:one", kind: "web", url: "https://example.test" }] };
  localStorage.setItem(sideLayoutKey(scope, "main"), JSON.stringify(layout));
  localStorage.setItem(sideLayoutKey({ ...scope, userId: "other" }, "foreign"), JSON.stringify(layout));
  render(<DesktopSideWorkspaceBridge />);
  await waitFor(() => expect(request).toHaveBeenCalledWith(scope, "sideWorkspaceSync", expect.objectContaining({ conversationId: "main", visible: false })));
  expect(request.mock.calls.some((call) => call[2].conversationId === "foreign")).toBe(false);
  request.mockClear(); act(() => availability({ state: "connected", sidecar: "ready" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(scope, "sideWorkspaceSync", expect.objectContaining({ conversationId: "main" })));
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
