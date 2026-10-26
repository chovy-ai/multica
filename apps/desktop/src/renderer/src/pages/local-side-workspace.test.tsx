import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalConversation } from "@multica/tutti-agent-gui-host/local-protocol";
import { LocalSideWorkspace, type SideWorkspaceHandle } from "./local-side-workspace";

vi.mock("@multica/views/conversation-flow/panel", () => ({ TuttiAgentGuiPanel: ({ activeSessionId, active }: { activeSessionId: string; active: boolean }) => <textarea aria-label={`Side draft ${activeSessionId}`} data-active={String(active)} /> }));
const scope = { userId: "side-user", workspaceId: "side-workspace" };
let queryClient: QueryClient;
let sessions: LocalConversation[];
let request: ReturnType<typeof vi.fn>;
const preview = { request: vi.fn(), subscribe: vi.fn(() => () => {}) };
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  sessions = [{ id: "main", provider: "codex", title: "Main conversation", cwd: "/project", model: "main-model", messages: [], turns: [], createdAt: "2026-10-24", updatedAt: "2026-10-24", archived: false, pinned: false }];
  request = vi.fn(async (_scope, method, params) => {
    if (method === "sideCreate") { const side = { ...sessions[0]!, id: "new-side", side: { sourceId: "main", requestId: params.requestId, context: [] } }; sessions.push(side); return side; }
    if (method === "read") return sessions.find((entry) => entry.id === params.id);
    if (method === "previewChoose") return { root: "/project", path: "/project", name: "project", kind: "directory" };
    if (method === "previewList") return [{ root: "/project", path: "/project/test.ts", name: "test.ts", kind: "file" }, { root: "/project", path: "/project/nested", name: "nested", kind: "directory" }];
    if (method === "previewRead") return { name: "test.ts", path: "/project/test.ts", mimeType: "text/plain", text: "export const ready = true;", size: 26, truncated: false };
    return undefined;
  });
  preview.request.mockImplementation(async (_scope, command) => command.action === "close" || command.action === "hide" ? null : { id: command.id, url: command.url, title: "Example", loading: false, canGoBack: false, canGoForward: false });
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { localConversations: { request, subscribe: () => () => {} }, resourcePreview: preview, openExternal: vi.fn() } });
});
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals(); localStorage.clear(); });
function setup() {
  const ref = createRef<SideWorkspaceHandle>(); const onSelectSource = vi.fn();
  const view = render(<QueryClientProvider client={queryClient}><LocalSideWorkspace ref={ref} scope={scope} slug="test" source={sessions[0]} provider="codex" sessions={sessions} chinese active onSelectSource={onSelectSource} onOpenTask={() => {}} onShowMessage={() => {}} onReference={() => {}}>{(visible) => <textarea aria-label="Main draft" data-visible={String(visible)} />}</LocalSideWorkspace></QueryClientProvider>);
  return { ...view, ref, onSelectSource };
}
it("creates a Side without replacing the main draft, retains its draft when closed, and returns to its source", async () => {
  const { ref, onSelectSource } = setup(); const main = screen.getByRole("textbox", { name: "Main draft" });
  fireEvent.change(main, { target: { value: "Keep main text" } });
  ref.current!.toggle();
  fireEvent.click(await screen.findByRole("button", { name: "新建旁支" }));
  const side = await screen.findByRole("textbox", { name: "Side draft new-side" });
  expect(request).toHaveBeenCalledWith(scope, "sideCreate", expect.objectContaining({ id: "main" }));
  expect(screen.getByRole("textbox", { name: "Main draft" })).toBe(main); expect(main).toHaveValue("Keep main text");
  fireEvent.change(side, { target: { value: "Keep side text" } });
  fireEvent.click(screen.getByRole("button", { name: "定位来源" })); expect(onSelectSource).toHaveBeenCalledWith("main", undefined, undefined);
  fireEvent.click(screen.getByRole("button", { name: "关闭右侧面板" }));
  await waitFor(() => expect(side).toHaveAttribute("data-active", "false"));
  ref.current!.toggle();
  expect(await screen.findByRole("textbox", { name: "Side draft new-side" })).toBe(side); expect(side).toHaveValue("Keep side text");
});
it("uses the shared tabs for a folder preview, loads subfolders lazily and reads the selected file", async () => {
  const { ref } = setup(); ref.current!.toggle();
  fireEvent.click(await screen.findByRole("button", { name: "添加右侧内容" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "打开文件夹" }));
  const tab = await screen.findByRole("tab", { name: "project" }); expect(tab).toHaveAttribute("aria-selected", "true");
  const file = await screen.findByRole("button", { name: "test.ts" });
  expect(request.mock.calls.filter((call) => call[1] === "previewList")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "nested" })).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(file);
  expect(await screen.findByText("export const ready = true;")).toBeVisible();
  expect(request).toHaveBeenCalledWith(scope, "previewRead", expect.objectContaining({ path: "/project/test.ts" }));
});
it.each([
  ["file:///project/output/%E6%88%BF%E9%97%B4%20report.html#L12", "/project/output/房间 report.html", 12],
  ["/project/output/%E6%88%BF%E9%97%B4%20report.html:12", "/project/output/房间 report.html", 12],
  ["output/cases.html", "/project/output/cases.html", undefined],
])("previews a transcript file using the source folder and decoded path: %s", async (href, path, line) => {
  const { ref } = setup();
  await act(async () => { await ref.current!.openResource("main", href); });
  expect(request).toHaveBeenCalledWith(scope, "previewRead", { root: "/project", path, id: "main" });
  expect(await screen.findByRole("tab", { name: "test.ts" })).toHaveAttribute("aria-selected", "true");
  if (line) expect(await screen.findByText(`第 ${line} 行`)).toBeVisible();
});
it("rejects foreign file URLs before reading a local resource", async () => {
  const { ref } = setup();
  await expect(ref.current!.openResource("main", "file://server/project/cases.html")).rejects.toThrow("Use a local file path");
  expect(request.mock.calls.filter(([, method]) => method === "previewRead")).toEqual([]);
});
it("opens a web tab in the same workspace and closes its native view with the tab", async () => {
  const { ref } = setup(); ref.current!.toggle();
  fireEvent.click(await screen.findByRole("button", { name: "添加右侧内容" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "打开网页" }));
  const dialog = await screen.findByRole("dialog", { name: "打开网页" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "网页地址" }), { target: { value: "https://example.com/guide" } });
  fireEvent.submit(within(dialog).getByRole("button", { name: "打开" }).closest("form")!);
  expect(await screen.findByRole("tab", { name: "example.com" })).toBeVisible();
  await waitFor(() => expect(preview.request.mock.calls.some(([, command]) => command.action === "show" && command.url === "https://example.com/guide")).toBe(true));
  const globalPreview = document.createElement("dialog");
  globalPreview.setAttribute("role", "presentation");
  document.body.append(globalPreview);
  await act(async () => { globalPreview.setAttribute("role", "dialog"); });
  await waitFor(() => expect(preview.request.mock.calls.at(-1)?.[1].action).toBe("hide"));
  await act(async () => { globalPreview.setAttribute("role", "presentation"); });
  await waitFor(() => expect(preview.request.mock.calls.at(-1)?.[1].action).toBe("show"));
  globalPreview.remove();
  fireEvent.click(screen.getByRole("button", { name: "关闭 example.com" }));
  await waitFor(() => expect(preview.request.mock.calls.some(([, command]) => command.action === "close")).toBe(true));
});
