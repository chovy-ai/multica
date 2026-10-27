import { LOCAL_CONVERSATION_METHODS } from "@multica/tutti-agent-gui-host/local-protocol";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalConversation, LocalFolderProject } from "@multica/tutti-agent-gui-host/local-protocol";
import type { Project } from "@multica/core/types";
import { LocalConversationFlowPage } from "./local-conversation-flow";
import { useProjectVisibilityStore } from "../stores/local-conversation-project-visibility";
import { useConversationLayoutStore } from "../stores/local-conversation-layout";

const mock = vi.hoisted(() => ({ request: vi.fn(), replace: vi.fn(), pathname: "/test/conversations", selected: "source", error: vi.fn(), success: vi.fn(), copyText: vi.fn(), compact: false, projects: [] as Project[], folders: [] as LocalFolderProject[], folderError: null as Error | null }));
vi.mock("@multica/ui/lib/clipboard", () => ({ copyText: mock.copyText }));
vi.mock("@multica/core/projects/queries", () => ({ projectListOptions: () => ({ queryKey: ["test-projects"], queryFn: async () => mock.projects }) }));
vi.mock("sonner", () => ({ toast: { error: mock.error, success: mock.success, info: vi.fn() } }));
vi.mock("@multica/core/auth", () => ({ useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: { id: "user" } }) }));
vi.mock("@multica/core/paths", () => ({ useCurrentWorkspace: () => ({ id: "workspace" }), useRequiredWorkspaceSlug: () => "test", useWorkspacePaths: () => ({ conversationFlow: () => "/test/conversations" }) }));
vi.mock("@multica/core/platform", () => ({ getCurrentSlug: () => "test" }));
vi.mock("@multica/views/navigation", () => ({
  useNavigation: () => ({ pathname: mock.pathname, searchParams: new URLSearchParams({ session: mock.selected }), replace: mock.replace }),
  AppLink: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@multica/views/i18n", () => ({ useLocale: () => "zh-Hans" }));
vi.mock("@multica/ui/hooks/use-mobile", () => ({ useIsCompact: () => mock.compact }));
vi.mock("@multica/views/runtimes/provider-logo", () => ({ ProviderLogo: () => null }));
vi.mock("@multica/views/conversation-flow/panel", () => ({ TuttiAgentGuiPanel: () => <textarea aria-label="Conversation draft" /> }));
vi.mock("../platform/local-conversation-service", () => ({ localConversationKey: () => ["test-local-sessions"], localTargetId: (provider: string) => `local:${provider}`, createLocalConversationParentService: vi.fn() }));

let qc: QueryClient;
let source: LocalConversation;
beforeEach(() => {
  useConversationLayoutStore.setState({ sessionListWidth: 268 });
  useProjectVisibilityStore.setState({ hiddenByScope: {} });
  vi.clearAllMocks(); mock.selected = "source"; mock.pathname = "/test/conversations";
  mock.compact = false;
  mock.projects = [];
  mock.folders = [];
  mock.folderError = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  source = { id: "source", title: "Original", provider: "codex", cwd: "/owned/work", providerSessionId: "native", model: null, pinned: false, archived: false, createdAt: "2026-01-01", updatedAt: "2026-01-01", messages: [{ id: "message", role: "assistant", content: "Result", turnId: "turn", createdAt: "2026-01-01" }], turns: [] };
  mock.request.mockImplementation(async (_scope, method) => method === "list" ? [source] : method === "providers" ? [{ id: "codex", available: true }] : undefined);
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { localConversations: { request: (scope: unknown, method: string, params: unknown) => method === "capabilities" ? Promise.resolve({ protocolVersion: 1, methods: Object.keys(LOCAL_CONVERSATION_METHODS) }) : method === "folderProjects" ? mock.folderError ? Promise.reject(mock.folderError) : Promise.resolve(mock.folders) : mock.request(scope, method, params), subscribe: () => () => {} } } });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => { cleanup(); qc.clear(); useProjectVisibilityStore.setState({ hiddenByScope: {} }); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.removeItem("multica_local_conversation_width"); localStorage.removeItem("multica-side-workspace:user:workspace"); });
const page = () => <QueryClientProvider client={qc}><LocalConversationFlowPage /></QueryClientProvider>;
const folder = (id: string, title: string, path = "/owned/work"): LocalFolderProject => ({ id, title, path, createdAt: "2026-01-01T00:00:00Z" });
function activateWithPointer(element: HTMLElement) {
  const pointerDown = new MouseEvent("pointerdown", { bubbles: true, button: 0 });
  Object.defineProperty(pointerDown, "pointerType", { value: "mouse" });
  fireEvent(element, pointerDown);
  fireEvent.pointerUp(element, { pointerType: "mouse", button: 0 });
  fireEvent.click(element, { button: 0, detail: 1 });
}

describe("restoring the selected conversation after a tab switch", () => {
  it("leaves image markers out of local session previews without changing saved history", async () => {
    source.messages = [{ id: "image-message", role: "user", content: "Can you see it?\n\n[Image attachment: screen.png]", attachmentIds: ["image"], turnId: "turn", createdAt: source.createdAt }];
    render(page());
    const entry = await screen.findByRole("link", { name: /Original/ });
    expect(entry).toHaveTextContent("Codex · Can you see it?");
    expect(entry).not.toHaveTextContent("Image attachment");
    expect(source.messages[0]?.content).toContain("[Image attachment:");
  });
  it("does not clear selection against a stale list while the restored tab refreshes", async () => {
    qc.setQueryDefaults(["test-local-sessions"], { staleTime: Infinity });
    qc.setQueryData(["test-local-sessions"], [source]);
    const restored = { ...source, id: "restored-session", title: "Previously selected conversation", provider: "claude" as const };
    mock.selected = restored.id;
    let resolve!: (entries: LocalConversation[]) => void;
    mock.request.mockImplementation(async (_scope, method) => method === "list" ? new Promise<LocalConversation[]>((done) => { resolve = done; }) : []);
    render(page());
    await waitFor(() => expect(mock.request).toHaveBeenCalledWith(expect.anything(), "list", {}));
    expect(mock.replace).not.toHaveBeenCalled();
    await act(async () => { resolve([source, restored]); });
    expect(await screen.findByRole("link", { name: /Previously selected conversation/ })).toHaveAttribute("aria-current", "true");
    expect(mock.replace).not.toHaveBeenCalled();
  });

  it("leaves another tab's session alone while the conversation page unmounts and restores its original item on return", async () => {
    const view = render(page());
    expect(await screen.findByRole("link", { name: /Original/ })).toHaveAttribute("aria-current", "true");
    mock.pathname = "/test/chat"; mock.selected = "other-tab-chat-session";
    view.rerender(page());
    expect(mock.replace).not.toHaveBeenCalled();
    mock.pathname = "/test/conversations"; mock.selected = source.id;
    view.rerender(page());
    expect(screen.getByRole("link", { name: /Original/ })).toHaveAttribute("aria-current", "true");
    expect(mock.replace).not.toHaveBeenCalled();
  });

  it("still clears a missing conversation after the active tab's fresh list has loaded", async () => {
    mock.selected = "deleted-session";
    render(page());
    await waitFor(() => expect(mock.replace).toHaveBeenCalledWith("/test/conversations?provider=codex"));
  });
});

describe("local conversation execution indicators", () => {
  it("shows a background conversation's unread reply and preserves the running indicator", async () => {
    mock.selected = "";
    source.hasUnread = true;
    render(page());
    expect(await screen.findByRole("status", { name: "未读回复：Original" })).toBeVisible();
    source = { ...source, turns: [{ id: "new-turn", status: "running", createdAt: "2026-01-01", events: [] }] };
    await act(async () => { await qc.invalidateQueries({ queryKey: ["test-local-sessions"] }); });
    expect(await screen.findByRole("status", { name: "会话运行中：Original" })).toBeVisible();
    expect(screen.queryByRole("status", { name: "未读回复：Original" })).not.toBeInTheDocument();
    expect(mock.request.mock.calls.some(([, method]) => method === "markRead")).toBe(false);
  });
  it("acknowledges the selected reply only when the window is focused", async () => {
    source.hasUnread = true;
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    render(page());
    await screen.findByRole("link", { name: /Original/ });
    expect(mock.request.mock.calls.some(([, method]) => method === "markRead")).toBe(false);
    focus.mockReturnValue(true);
    fireEvent.focus(window);
    await waitFor(() => expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "markRead", { id: "source", messageId: "message" }));
    expect(screen.queryByRole("status", { name: "未读回复：Original" })).not.toBeInTheDocument();
  });
  it("does not acknowledge the selected reply in an inactive tab", async () => {
    source.hasUnread = true;
    mock.pathname = "/test/chat";
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(page());
    await screen.findByRole("link", { name: /Original/ });
    fireEvent.focus(window);
    expect(mock.request.mock.calls.some(([, method]) => method === "markRead")).toBe(false);
  });
  it("distinguishes background monitoring from a foreground reply and can stop it from the session menu", async () => {
    source = { ...source, provider: "claude", turns: [{ id: "finished-turn", status: "completed", createdAt: "2026-01-01", events: [], backgroundTasks: [{ id: "watcher", description: "Wait for PR to merge", status: "running" }] }] };
    mock.request.mockImplementation(async (_scope, method) => {
      if (method === "stopBackgroundTasks") { source = { ...source, turns: [] }; return undefined; }
      return method === "list" ? [source] : [];
    });
    render(page());
    expect(await screen.findByRole("status", { name: "后台运行中：Original（1）" })).toBeVisible();
    expect(screen.queryByRole("status", { name: "会话运行中：Original" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "会话操作：Original" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "停止后台任务" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "后台运行中：Original（1）" })).not.toBeInTheDocument());
    expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "stopBackgroundTasks", { id: "source" });
  });
  it.each([
    ["codex", "completed"], ["codex", "failed"], ["codex", "cancelled"],
    ["claude", "completed"], ["claude", "failed"], ["claude", "cancelled"],
  ] as const)("updates the %s row from idle through running to %s after execution notifications", async (provider, status) => {
    source = { ...source, provider };
    let notify!: Parameters<typeof window.desktopAPI.localConversations.subscribe>[0];
    vi.spyOn(window.desktopAPI.localConversations, "subscribe").mockImplementation((listener) => { notify = listener; return () => {}; });
    render(page());
    await screen.findByRole("link", { name: /Original/ });
    expect(screen.queryByRole("status", { name: "会话运行中：Original" })).not.toBeInTheDocument();

    source = { ...source, turns: [{ id: "active-turn", status: "running", createdAt: "2026-01-01", events: [] }] };
    act(() => notify({ userId: "user", workspaceId: "workspace" }, source.id));
    expect(await screen.findByRole("status", { name: "会话运行中：Original" })).toBeVisible();

    source = { ...source, turns: source.turns.map((turn) => ({ ...turn, status })) };
    act(() => notify({ userId: "user", workspaceId: "workspace" }, source.id));
    await waitFor(() => expect(screen.queryByRole("status", { name: "会话运行中：Original" })).not.toBeInTheDocument());
  });

  it("shows background execution independently of selection and keeps its actions available until all turns settle", async () => {
    let background: LocalConversation = { ...source, id: "background", title: "Background conversation", turns: [
      { id: "first-agent", status: "running", createdAt: "2026-01-01", events: [], remote: { agentId: "a", agentName: "First agent" } },
      { id: "second-agent", status: "running", createdAt: "2026-01-01", events: [], remote: { agentId: "b", agentName: "Second agent" } },
    ] };
    mock.request.mockImplementation(async (_scope, method) => method === "list" ? [source, background] : []);
    let notify!: Parameters<typeof window.desktopAPI.localConversations.subscribe>[0];
    vi.spyOn(window.desktopAPI.localConversations, "subscribe").mockImplementation((listener) => { notify = listener; return () => {}; });
    render(page());
    expect(await screen.findByRole("status", { name: "会话运行中：Background conversation" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Original/ })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("status", { name: "会话运行中：Original" })).not.toBeInTheDocument();
    const menu = screen.getByRole("button", { name: "会话操作：Background conversation" });
    expect(menu).toBeEnabled();
    fireEvent.click(menu);
    expect(await screen.findByRole("menuitem", { name: "复制会话 ID" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    background = { ...background, turns: background.turns.slice(1) };
    act(() => notify({ userId: "user", workspaceId: "workspace" }, background.id));
    await waitFor(() => expect(mock.request.mock.calls.filter((call) => call[1] === "list")).toHaveLength(2));
    expect(screen.getByRole("status", { name: "会话运行中：Background conversation" })).toBeVisible();
    background = { ...background, turns: [] };
    act(() => notify({ userId: "user", workspaceId: "workspace" }, background.id));
    await waitFor(() => expect(screen.queryByRole("status", { name: "会话运行中：Background conversation" })).not.toBeInTheDocument());
    expect(mock.replace).not.toHaveBeenCalled();
  });
});

describe("removing projects from the local conversation list", () => {
  it("opens project actions for a pointer activation without compatibility mouse events", async () => {
    mock.folders = [folder("project-a", "Pointer project")];
    render(page());
    const group = await screen.findByRole("region", { name: "Pointer project" });
    const trigger = within(group).getByRole("button", { name: "项目操作：Pointer project" });
    activateWithPointer(trigger);
    expect(await screen.findByRole("menuitem", { name: "从列表移除" })).toBeVisible();
  });
  it("hides a project without mutating its conversations or replacing the active draft, and restores it from the list", async () => {
    mock.folders = [folder("project-a", "Removable project")];
    const original = structuredClone(source);
    render(page());
    const group = await screen.findByRole("region", { name: "Removable project" });
    const draft = screen.getByRole("textbox", { name: "Conversation draft" });
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    const projectMenu = within(group).getByRole("button", { name: "项目操作：Removable project" });
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true, button: 0 });
    Object.defineProperty(pointerDown, "pointerType", { value: "mouse" });
    fireEvent(projectMenu, pointerDown);
    fireEvent.mouseDown(projectMenu, { button: 0 });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    fireEvent.pointerUp(projectMenu, { pointerType: "mouse", button: 0 });
    fireEvent.mouseUp(projectMenu, { button: 0 });
    fireEvent.click(projectMenu, { button: 0, detail: 1 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "从列表移除" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Removable project" })).not.toBeInTheDocument());
    expect(source).toEqual(original);
    expect(mock.request.mock.calls.every((call) => ["list", "providers"].includes(call[1]))).toBe(true);
    expect(mock.replace).not.toHaveBeenCalled();
    expect(draft).toHaveValue("Keep this draft");
    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), { target: { value: "Original" } });
    expect(screen.queryByRole("region", { name: "Removable project" })).not.toBeInTheDocument();
    activateWithPointer(screen.getByRole("button", { name: "已移除项目（1）" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "恢复项目：Removable project" }));
    expect(await screen.findByRole("region", { name: "Removable project" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Original/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: "已移除项目（1）" })).not.toBeInTheDocument();
  });
  it("keeps a removed empty project hidden after remounting and supports undo", async () => {
    mock.folders = [folder("project-a", "Empty project", "/owned/empty")];
    const mounted = render(page());
    const group = await screen.findByRole("region", { name: "Empty project" });
    fireEvent.click(within(group).getByRole("button", { name: "项目操作：Empty project" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "从列表移除" }));
    const notification = mock.success.mock.calls.at(-1)!;
    mounted.unmount();
    render(page());
    expect(await screen.findByRole("button", { name: "已移除项目（1）" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Empty project" })).not.toBeInTheDocument();
    await act(async () => { notification[1].action.onClick(); });
    expect(await screen.findByRole("region", { name: "Empty project" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "项目操作：未分配项目" })).not.toBeInTheDocument();
  });
});

describe("local conversation project creation", () => {
  it("explains a stale desktop process for both folder loading and adding instead of reporting a generic project failure", async () => {
    const error = new Error("Error invoking remote method 'local-conversation:request': Error: Unknown local conversation request");
    mock.folderError = error;
    mock.request.mockImplementation(async (_scope, method) => {
      if (method === "folderProjectAdd") throw error;
      return method === "list" ? [source] : [{ id: "codex", available: true }];
    });
    render(page());
    expect(await screen.findByText("本地项目功能已更新，请重启桌面应用")).toBeVisible();
    expect(screen.queryByText("本地项目加载失败")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(mock.error).toHaveBeenCalledWith("本地项目功能已更新，请重启桌面应用"));
    expect(mock.replace).not.toHaveBeenCalled();
  });
  it("adds a chosen local folder without leaving the conversation and uses it for new sessions", async () => {
    mock.projects = [{ id: "cloud-project", workspace_id: "workspace", title: "Cloud task project" }] as Project[];
    mock.request.mockImplementation(async (_scope, method) => {
      if (method === "folderProjectAdd") { const project = folder("created-project", "local-repository", "/owned/local-repository"); mock.folders = [project]; return project; }
      if (method === "create") return { ...source, id: "new-session", cwd: "/owned/local-repository", messages: [] };
      return method === "list" ? [source] : [{ id: "codex", available: true }];
    });
    render(page());
    await screen.findByRole("link", { name: /Original/ });
    const draft = screen.getByRole("textbox", { name: "Conversation draft" });
    fireEvent.change(draft, { target: { value: "Keep my draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), { target: { value: "Original" } });
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    const group = await screen.findByRole("region", { name: "local-repository" });
    expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "folderProjectAdd", {});
    expect(mock.replace).not.toHaveBeenCalled();
    expect(draft).toHaveValue("Keep my draft");
    expect(screen.getByRole("textbox", { name: "搜索会话" })).toHaveValue("");
    expect(within(group).getByText("暂无会话")).toBeVisible();
    expect(within(group).getByRole("button", { name: "local-repository" })).toHaveAttribute("title", "/owned/local-repository");
    expect(screen.queryByRole("region", { name: "Cloud task project" })).not.toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "新建项目会话：local-repository" }));
    await waitFor(() => expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "create", { provider: "codex", folderProjectId: "created-project" }));
  });
  it("allows project creation when no local model runner is installed", async () => {
    mock.request.mockImplementation(async (_scope, method) => method === "folderProjectAdd" ? null : method === "list" ? [source] : [{ id: "codex", available: false }]);
    render(page());
    await screen.findByRole("link", { name: /Original/ });
    expect(screen.getByRole("button", { name: "新建项目" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "folderProjectAdd", {}));
  });
  it.each([false, true])("keeps the current search and conversation when folder selection fails=%s or is cancelled", async (failed) => {
    mock.request.mockImplementation(async (_scope, method) => {
      if (method === "folderProjectAdd") { if (failed) throw new Error("Could not open folder picker"); return null; }
      return method === "list" ? [source] : [{ id: "codex", available: true }];
    });
    render(page());
    await screen.findByRole("link", { name: /Original/ });
    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), { target: { value: "Original" } });
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "新建项目" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "搜索会话" })).toHaveValue("Original");
    expect(mock.replace).not.toHaveBeenCalled();
    if (failed) expect(mock.error).toHaveBeenCalledWith("Could not open folder picker");
    else expect(mock.error).not.toHaveBeenCalled();
  });
});

describe("local conversation context menu", () => {
  afterEach(() => { window.getSelection()?.removeAllRanges(); });
  it.each(["context", "dropdown"])("copies the targeted Multica conversation ID from the %s menu", async (menu) => {
    const other = { ...source, id: "copied-multica-id", providerSessionId: "private-native-id", title: "Other conversation" };
    mock.request.mockImplementation(async (_scope, method) => method === "list" ? [source, other] : []);
    mock.copyText.mockResolvedValue(true);
    render(page());
    const row = await screen.findByRole("link", { name: /Other conversation/ });
    if (menu === "context") fireEvent.contextMenu(row, { button: 2 });
    else fireEvent.click(screen.getByRole("button", { name: "会话操作：Other conversation" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制会话 ID" }));
    await waitFor(() => expect(mock.success).toHaveBeenCalledWith("已复制会话 ID"));
    expect(mock.copyText).toHaveBeenCalledExactlyOnceWith("copied-multica-id");
    expect(mock.request.mock.calls.every((call) => call[1] === "list" || call[1] === "providers")).toBe(true);
    expect(mock.replace).not.toHaveBeenCalled();
  });
  it("reports clipboard failure without reporting success", async () => {
    mock.copyText.mockResolvedValue(false);
    render(page());
    fireEvent.contextMenu(await screen.findByRole("link", { name: /Original/ }), { button: 2 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制会话 ID" }));
    await waitFor(() => expect(mock.error).toHaveBeenCalledWith("无法复制会话 ID，请重试"));
    expect(mock.success).not.toHaveBeenCalled();
  });
  it.each(["context", "dropdown"])("renames the targeted session from the %s menu without leaving the active draft", async (menu) => {
    let other = { ...source, id: "other", title: "Other conversation" };
    mock.request.mockImplementation(async (_scope, method, params) => {
      if (method === "update") { other = { ...other, title: params.title }; return other; }
      return method === "list" ? [source, other] : [];
    });
    render(page());
    const draft = screen.getByRole("textbox", { name: "Conversation draft" });
    fireEvent.change(draft, { target: { value: "Keep my draft" } });
    const row = await screen.findByRole("link", { name: /Other conversation/ });
    if (menu === "context") fireEvent.contextMenu(row, { button: 2 });
    else fireEvent.click(screen.getByRole("button", { name: "会话操作：Other conversation" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const dialog = await screen.findByRole("dialog", { name: "重命名会话" });
    const input = within(dialog).getByRole("textbox", { name: "会话名称" });
    expect(input).toHaveValue("Other conversation");
    fireEvent.change(input, { target: { value: "   " } });
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "  Renamed conversation  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "update", { id: "other", title: "Renamed conversation" });
    expect(screen.getByRole("link", { name: /Renamed conversation/ })).toBeInTheDocument();
    expect(mock.replace).not.toHaveBeenCalled();
    expect(draft).toHaveValue("Keep my draft");
  });
  it("keeps a failed rename editable and only closes after a successful retry", async () => {
    let reject!: (error: Error) => void;
    mock.request.mockImplementation(async (_scope, method) => method === "update" ? new Promise((_resolve, fail) => { reject = fail; }) : method === "list" ? [source] : []);
    render(page());
    fireEvent.contextMenu(await screen.findByRole("link", { name: /Original/ }), { button: 2 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const dialog = await screen.findByRole("dialog", { name: "重命名会话" });
    const input = within(dialog).getByRole("textbox", { name: "会话名称" });
    fireEvent.change(input, { target: { value: "My title" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(within(dialog).getByRole("button", { name: "正在保存..." })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).toBeInTheDocument();
    await act(async () => { reject(new Error("Could not save title")); });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Could not save title");
    expect(input).toHaveValue("My title");
    expect(input).toBeEnabled();
    mock.request.mockImplementation(async (_scope, method, params) => {
      if (method === "update") { source = { ...source, title: params.title }; return source; }
      return method === "list" ? [source] : [];
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: /My title/ })).toBeInTheDocument();
  });
  it.each(["codex", "claude"] as const)("forks the right-clicked %s session and opens the saved branch", async (provider) => {
    const other = { ...source, id: "other", provider, title: "Fork this conversation" };
    const branch = { ...other, id: "branch", title: "Fork this conversation · Fork", forkedFrom: other.id };
    let rows = [source, other];
    let release!: (entry: LocalConversation) => void;
    mock.request.mockImplementation(async (_scope, method) => method === "fork" ? new Promise((resolve) => { release = resolve; }) : method === "list" ? rows : []);
    render(page());
    fireEvent.contextMenu(await screen.findByRole("link", { name: /Fork this conversation/ }), { button: 2 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "分叉" }));
    expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "fork", { id: "other" });
    expect(mock.replace).not.toHaveBeenCalled();
    rows = [...rows, branch];
    await act(async () => { release(branch); });
    await waitFor(() => expect(mock.replace).toHaveBeenCalledWith(`/test/conversations?provider=${provider}&session=branch`));
    expect(screen.getByRole("link", { name: /Fork this conversation · Fork/ })).toBeInTheDocument();
    expect(rows.find((entry) => entry.id === "source")).toBe(source);
  });
  it("disables full forks for a running or unbound session", async () => {
    source.turns = [{ id: "running", status: "running", events: [], createdAt: "2026-01-01" }];
    render(page());
    fireEvent.contextMenu(await screen.findByRole("link", { name: /Original/ }), { button: 2 });
    expect(await screen.findByRole("menuitem", { name: "分叉" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await act(async () => { qc.setQueryData(["test-local-sessions"], [{ ...source, providerSessionId: undefined, turns: [] }]); });
    fireEvent.contextMenu(screen.getByRole("link", { name: /Original/ }), { button: 2 });
    expect(await screen.findByRole("menuitem", { name: "分叉" })).toHaveAttribute("aria-disabled", "true");
    expect(mock.request.mock.calls.some((call) => call[1] === "fork")).toBe(false);
  });
  it("persists pin and unpin through the context menu", async () => {
    mock.request.mockImplementation(async (_scope, method, params) => {
      if (method === "update") { source = { ...source, pinned: params.pinned }; return source; }
      return method === "list" ? [source] : [];
    });
    render(page());
    fireEvent.contextMenu(await screen.findByRole("link", { name: /Original/ }), { button: 2 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "置顶" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "会话操作：Original" })).toBeEnabled());
    fireEvent.contextMenu(screen.getByRole("link", { name: /Original/ }), { button: 2 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "取消置顶" }));
    await waitFor(() => expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "update", { id: "source", pinned: false }));
    expect(mock.replace).not.toHaveBeenCalled();
  });
  it("takes over right-click on an inactive row without navigating or replacing the draft", async () => {
    const other = { ...source, id: "other", title: "Other conversation" };
    mock.request.mockImplementation(async (_scope, method) => method === "list" ? [source, other] : []);
    render(page());
    const draft = screen.getByRole("textbox", { name: "Conversation draft" });
    fireEvent.change(draft, { target: { value: "Keep my draft" } });
    const row = await screen.findByRole("link", { name: /Other conversation/ });
    expect(fireEvent.contextMenu(row, { button: 2, clientX: 120, clientY: 160 })).toBe(false);
    const menu = await screen.findByRole("menu", { name: "会话操作：Other conversation" });
    expect(menu).toHaveAttribute("data-slot", "context-menu-content");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "置顶" }));
    await waitFor(() => expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "update", { id: "other", pinned: true }));
    expect(mock.replace).not.toHaveBeenCalled();
    expect(draft).toHaveValue("Keep my draft");
  });
  it("moves the right-clicked session through the shared project submenu", async () => {
    mock.projects = [{ id: "project-a", workspace_id: "workspace", title: "Multica Project" }] as Project[];
    render(page());
    fireEvent.contextMenu(await screen.findByRole("link", { name: /Original/ }), { button: 2 });
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "关联工作区项目" }), { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Multica Project" }));
    await waitFor(() => expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "update", { id: "source", projectId: "project-a" }));
    expect(mock.replace).not.toHaveBeenCalled();
  });
  it("copies the selected row text and dismisses with Escape", async () => {
    mock.copyText.mockResolvedValue(true);
    render(page());
    const row = await screen.findByRole("link", { name: /Original/ });
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(within(row).getByText("Original"));
    selection.removeAllRanges(); selection.addRange(range);
    fireEvent.contextMenu(row, { button: 2 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制所选文字" }));
    await waitFor(() => expect(mock.copyText).toHaveBeenCalledWith("Original"));
    selection.removeAllRanges();
    fireEvent.contextMenu(row, { button: 2 });
    const menu = await screen.findByRole("menu", { name: "会话操作：Original" });
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(mock.replace).not.toHaveBeenCalled();
  });
});

describe("Side conversations in the main session list", () => {
  it.each(["codex", "claude"] as const)("keeps %s Sides in the right workspace while excluding them from the list, search, archives and counts", async (provider) => {
    mock.folders = [folder("project-a", "Main project")];
    const side: LocalConversation = { ...source, id: "side", title: "Side exploration", provider, side: { sourceId: source.id, turnId: "turn", quote: "Quoted source text", requestId: "side-request", context: [] } };
    const fork = { ...source, id: "fork", title: "Independent fork", cwd: "/other", forkedFrom: source.id };
    const archived = { ...source, id: "archived", title: "Archived main", archived: true };
    const rows = [source, fork, archived, side, { ...side, id: "side-draft", title: "Side draft", messages: [] }, { ...side, id: "side-archive", title: "Side archive", archived: true }];
    mock.request.mockImplementation(async (_scope, method) => method === "list" ? rows : [{ id: provider, available: true }]);
    localStorage.setItem("multica-side-workspace:user:workspace", JSON.stringify({ tabs: [{ id: "side-tab", kind: "side", sessionId: side.id }], selected: "side-tab", open: true }));
    render(page());
    const list = within(screen.getByTestId("local-conversation-sessions"));
    expect(await list.findByRole("link", { name: /Original/ })).toBeVisible();
    expect(list.getByRole("link", { name: /Independent fork/ })).toBeVisible();
    expect(list.queryAllByRole("link", { name: /Side/ })).toHaveLength(0);
    expect(within(list.getByRole("button", { name: "Main project" })).getByText("1")).toBeInTheDocument();
    expect(within(list.getByRole("button", { name: "未分配项目" })).getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "旁支 · Side exploration" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Quoted source text")).toBeVisible();
    fireEvent.change(list.getByRole("textbox", { name: "搜索会话" }), { target: { value: "Side" } });
    expect(list.getByText("没有匹配的会话")).toBeVisible();
    fireEvent.change(list.getByRole("textbox", { name: "搜索会话" }), { target: { value: "" } });
    fireEvent.click(list.getByRole("button", { name: "归档" }));
    expect(list.getByRole("link", { name: /Archived main/ })).toBeVisible();
    expect(list.queryAllByRole("link", { name: /Side/ })).toHaveLength(0);
    expect(qc.getQueryData(["test-local-sessions"])).toEqual(rows);
    fireEvent.click(screen.getByRole("button", { name: "定位来源" }));
    expect(mock.replace).toHaveBeenCalledWith("/test/conversations?provider=codex&session=source");
    expect(list.getByRole("link", { name: /Original/ })).toBeVisible();
    expect(list.queryAllByRole("link", { name: /Side/ })).toHaveLength(0);
  });
});

describe("local conversation fork entry", () => {
  it("opens a saved fork's source even when the source is archived", async () => {
    source.forkedFrom = "parent"; source.forkedFromTurnId = "parent-turn"; source.forkMode = "saved-context";
    const parent = { ...source, id: "parent", title: "Source conversation", archived: true, forkedFrom: undefined };
    mock.request.mockImplementation(async (_scope, method) => method === "list" ? [source, parent] : [{ id: "codex", available: true }]);
    render(page());
    const back = await screen.findByRole("button", { name: "来源会话" });
    expect(back).toHaveAttribute("title", "Source conversation");
    expect(screen.getByText("上下文分叉")).toBeVisible();
    fireEvent.click(back);
    expect(mock.replace).toHaveBeenCalledWith("/test/conversations?provider=codex&session=parent");
  });
  it.each(["codex", "claude"] as const)("keeps unsent %s drafts out of the list and counts until the first message is accepted", async (provider) => {
    const draft = { ...source, id: "draft", title: "Unsent draft", provider, providerSessionId: undefined, messages: [], turns: [] };
    let rows: LocalConversation[] = [source, { ...draft, id: "old-draft", title: "Older unsent draft" }];
    mock.request.mockImplementation(async (_scope, method) => {
      if (method === "create") { rows = [...rows, draft]; return draft; }
      return method === "list" ? rows : [{ id: provider, available: true }];
    });
    const view = render(page());
    await screen.findByRole("link", { name: /Original/ });
    await waitFor(() => expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(mock.replace).toHaveBeenCalledWith(`/test/conversations?provider=${provider}&session=draft`));
    await waitFor(() => expect(qc.getQueryData<LocalConversation[]>(["test-local-sessions"])).toHaveLength(3));
    mock.selected = draft.id;
    view.rerender(page());
    fireEvent.change(screen.getByRole("textbox", { name: "Conversation draft" }), { target: { value: "Not sent yet" } });
    expect(screen.queryAllByRole("link", { name: /Unsent draft|Older unsent draft/ })).toHaveLength(0);
    expect(within(screen.getByRole("button", { name: "未分配项目" })).getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Conversation draft" })).toHaveValue("Not sent yet");

    const at = "2026-10-24T18:00:00Z";
    rows = rows.map((entry) => entry.id === draft.id ? { ...entry, title: "First submitted message", messages: [{ id: "first-message", role: "user", content: "First submitted message", turnId: "first-turn", createdAt: at }], turns: [{ id: "first-turn", status: "running", createdAt: at, events: [] }] } : entry);
    await act(async () => { await qc.invalidateQueries({ queryKey: ["test-local-sessions"] }); });
    expect(await screen.findByRole("link", { name: /First submitted message/ })).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "未分配项目" })).getByText("2")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Older unsent draft/ })).not.toBeInTheDocument();
  });
  it("collapses folder groups, reveals search matches, and creates directly inside the folder", async () => {
    mock.folders = [folder("project-a", "Multica Project")];
    const rows = [source];
    mock.request.mockImplementation(async (_scope, method, params) => {
      if (method === "create") { const created = { ...source, id: "new-project-session", cwd: mock.folders.find((project) => project.id === params.folderProjectId)!.path, providerSessionId: undefined, messages: [], turns: [] }; rows.push(created); return created; }
      return method === "list" ? rows : [{ id: "codex", available: true }];
    });
    render(page());
    const group = await screen.findByRole("button", { name: "Multica Project" });
    fireEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: /Original/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), { target: { value: "Multica Project" } });
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /Original/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建项目会话：Multica Project" }));
    await waitFor(() => expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "create", { provider: "codex", folderProjectId: "project-a" }));
    await waitFor(() => expect(mock.replace).toHaveBeenCalledWith("/test/conversations?provider=codex&session=new-project-session"));
    fireEvent.click(screen.getByRole("button", { name: "Multica Project" }));
    expect(screen.getAllByRole("link", { name: /Original/ })).toHaveLength(1);
  });
  it("keeps failed moves in their original group and exposes recovery", async () => {
    mock.projects = [{ id: "project-a", workspace_id: "workspace", title: "Multica Project" }] as Project[];
    mock.request.mockImplementation(async (_scope, method) => {
      if (method === "update") throw new Error("Could not save project");
      return method === "list" ? [source] : [];
    });
    render(page());
    fireEvent.click(await screen.findByRole("button", { name: "会话操作：Original" }));
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "关联工作区项目" }), { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Multica Project" }));
    await waitFor(() => expect(mock.error).toHaveBeenCalledWith("Could not save project"));
    expect(screen.getByRole("region", { name: "未分配项目" })).toContainElement(screen.getByRole("link", { name: /Original/ }));
    expect(screen.getByRole("button", { name: "会话操作：Original" })).not.toBeDisabled();
    expect(mock.replace).not.toHaveBeenCalled();
  });
  it("links a cloud project without changing local folder grouping or replacing its draft", async () => {
    mock.folders = [folder("local-folder", "Local folder")];
    mock.projects = [{ id: "project-a", workspace_id: "workspace", title: "Multica Project" }] as Project[];
    mock.request.mockImplementation(async (_scope, method, params) => {
      if (method === "update") { source = { ...source, projectId: params.projectId }; return source; }
      return method === "list" ? [source] : [{ id: "codex", available: true }];
    });
    render(page());
    const draft = screen.getByRole("textbox", { name: "Conversation draft" });
    fireEvent.change(draft, { target: { value: "Keep my draft" } });
    const move = async (label: string) => {
      fireEvent.click(await screen.findByRole("button", { name: "会话操作：Original" }));
      fireEvent.keyDown(await screen.findByRole("menuitem", { name: "关联工作区项目" }), { key: "ArrowRight" });
      fireEvent.click(await screen.findByRole("menuitemradio", { name: label }));
    };
    await move("Multica Project");
    await waitFor(() => expect(screen.getByRole("region", { name: "Local folder" })).toContainElement(screen.getByRole("link", { name: /Original/ })));
    expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "update", { id: "source", projectId: "project-a" });
    expect(screen.getByRole("textbox", { name: "Conversation draft" })).toBe(draft);
    expect(draft).toHaveValue("Keep my draft");
    await move("不关联工作区项目");
    await waitFor(() => expect(screen.getByRole("region", { name: "Local folder" })).toContainElement(screen.getByRole("link", { name: /Original/ })));
    expect(mock.replace).not.toHaveBeenCalled();
  });
  it("resizes with the pointer, respects limits, and restores the saved width", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    let groupWidth = 1000;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const list = document.getElementById("local-sessions");
      const width = list?.style.flexGrow ? Number(list.style.flexGrow) * groupWidth / 100 : 268;
      if (this.getAttribute("data-slot") === "resizable-handle") return new DOMRect(width, 0, 0, 700);
      if (this.id === "local-sessions") return new DOMRect(0, 0, width, 700);
      if (this.id === "local-detail") return new DOMRect(width, 0, groupWidth - width, 700);
      return new DOMRect(0, 0, groupWidth, 700);
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.getBoundingClientRect().width; });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.getBoundingClientRect().height; });
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) { return this.getBoundingClientRect().left; });
    let view = render(page());
    const handle = await screen.findByRole("separator", { name: "调整会话列表宽度" });
    await waitFor(() => expect(handle).toHaveAttribute("aria-valuenow", "26.8"));
    const drag = (from: number, to: number) => {
      fireEvent.pointerDown(handle, { clientX: from, clientY: 300, button: 0, buttons: 1 });
      fireEvent.pointerMove(document, { clientX: to, clientY: 300, buttons: 1 });
      fireEvent.pointerUp(document, { clientX: to, clientY: 300, buttons: 0 });
    };
    drag(268, 410);
    expect(handle).toHaveAttribute("aria-valuenow", "41");
    drag(410, 900);
    expect(handle).toHaveAttribute("aria-valuenow", "48");
    drag(480, 100);
    expect(handle).toHaveAttribute("aria-valuenow", "24");
    drag(240, 350);
    expect(handle).toHaveAttribute("aria-valuenow", "35");
    view.unmount();
    groupWidth = 1200;
    view = render(page());
    await waitFor(() => expect(document.getElementById("local-sessions")!.getBoundingClientRect().width).toBeCloseTo(350));
    view.unmount();
    groupWidth = 500;
    view = render(page());
    await waitFor(() => expect(document.getElementById("local-sessions")!.getBoundingClientRect().width).toBeLessThanOrEqual(300));
    view.unmount();
    groupWidth = 1000;
    view = render(page());
    await waitFor(() => expect(document.getElementById("local-sessions")!.getBoundingClientRect().width).toBeCloseTo(350));
    const restoredHandle = screen.getByRole("separator", { name: "调整会话列表宽度" });
    fireEvent.keyDown(restoredHandle, { key: "ArrowRight" });
    fireEvent.keyUp(restoredHandle, { key: "ArrowRight" });
    const keyboardWidth = document.getElementById("local-sessions")!.getBoundingClientRect().width;
    expect(keyboardWidth).toBeGreaterThan(350);
    view.unmount();
    view = render(page());
    await waitFor(() => expect(document.getElementById("local-sessions")!.getBoundingClientRect().width).toBeCloseTo(keyboardWidth));
    view.unmount();
  });
  it("keeps the mounted conversation and draft while switching between resizable and compact layouts", async () => {
    const view = render(page());
    const draft = await screen.findByRole("textbox", { name: "Conversation draft" });
    fireEvent.change(draft, { target: { value: "Unsent draft" } });
    expect(screen.getByRole("separator", { name: "调整会话列表宽度" })).toBeInTheDocument();
    mock.compact = true; view.rerender(page());
    expect(screen.getByRole("textbox", { name: "Conversation draft" })).toBe(draft);
    expect(draft).toHaveValue("Unsent draft");
    expect(screen.queryByRole("separator", { name: "调整会话列表宽度" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "本机会话" }));
    expect(draft).toBeInTheDocument();
    mock.compact = false; view.rerender(page());
    expect(screen.getByRole("textbox", { name: "Conversation draft" })).toBe(draft);
    expect(draft).toHaveValue("Unsent draft");
  });
  it("shows pending state and opens the persisted branch after a successful fork", async () => {
    let release!: (branch: LocalConversation) => void;
    mock.request.mockImplementation(async (_scope, method) => method === "list" ? [source] : method === "fork" ? new Promise((resolve) => { release = resolve; }) : []);
    render(page());
    const button = await screen.findByRole("button", { name: "分叉会话" });
    fireEvent.click(button);
    expect(mock.request).toHaveBeenCalledWith({ userId: "user", workspaceId: "workspace" }, "fork", { id: "source" });
    expect(button).toBeDisabled(); expect(button).toHaveAttribute("aria-busy", "true");
    expect(mock.replace).not.toHaveBeenCalled();
    release({ ...source, id: "branch", forkedFrom: "source" });
    await waitFor(() => expect(mock.replace).toHaveBeenCalledWith("/test/conversations?provider=codex&session=branch"));
    expect(button).toHaveAttribute("aria-busy", "false");
  });
  it("keeps the current conversation on failure and does not redirect after the user selects another session", async () => {
    mock.request.mockImplementation(async (_scope, method) => { if (method === "fork") throw new Error("Native fork failed"); return method === "list" ? [source] : []; });
    const view = render(page());
    fireEvent.click(await screen.findByRole("button", { name: "分叉会话" }));
    await waitFor(() => expect(mock.error).toHaveBeenCalledWith("Native fork failed"));
    expect(mock.replace).not.toHaveBeenCalled();
    let release!: (branch: LocalConversation) => void;
    mock.request.mockImplementation(async (_scope, method) => method === "list" ? [source, { ...source, id: "other" }] : method === "fork" ? new Promise((resolve) => { release = resolve; }) : []);
    fireEvent.click(screen.getByRole("button", { name: "分叉会话" }));
    act(() => { qc.setQueryData(["test-local-sessions"], [source, { ...source, id: "other" }]); });
    mock.selected = "other"; view.rerender(page());
    release({ ...source, id: "branch" });
    await waitFor(() => expect(screen.getByRole("button", { name: "分叉会话" })).toHaveAttribute("aria-busy", "false"));
    expect(mock.replace).not.toHaveBeenCalled();
  });
  it("disables forking while an execution is running", async () => {
    source.turns = [{ id: "turn", status: "running", createdAt: "2026-01-01", events: [] }];
    render(page());
    expect(await screen.findByRole("button", { name: "分叉会话" })).toBeDisabled();
  });
});
