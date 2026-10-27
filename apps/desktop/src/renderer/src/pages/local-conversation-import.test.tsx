import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalConversationClient, LocalImportCandidate } from "@multica/core/local-conversation/protocol";
import { LocalConversationImportButton } from "./local-conversation-import";

vi.mock("@multica/views/runtimes/provider-logo", () => ({ ProviderLogo: () => <span /> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); });
const scope = { userId: "user", workspaceId: "workspace" };
const candidate = (id: string, importedId?: string): LocalImportCandidate => ({ id, title: `History ${id}`, provider: "codex", cwd: `/work/${id}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", importedId });
function mount(request: ReturnType<typeof vi.fn>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(qc);
  const onImported = vi.fn();
  const client = { request, subscribe: () => () => {} } as LocalConversationClient;
  render(<QueryClientProvider client={qc}><LocalConversationImportButton scope={scope} client={client} projects={[{ id: "project-a", title: "Project A" }]} chinese onImported={onImported} /></QueryClientProvider>);
  return { onImported };
}
describe("local conversation import dialog", () => {
  it("explains when an already-running desktop needs to reload the new native interface", async () => {
    mount(vi.fn(async () => { throw new Error("Unknown local conversation request"); }));
    fireEvent.click(screen.getByRole("button", { name: "导入本机会话" }));
    await screen.findByText("重启 Multica 后可使用本机会话导入。");
    expect(screen.getByRole("button", { name: "导入所选 (0)" })).toBeDisabled();
  });
  it("scans only on demand, selects all pages, skips duplicates and imports into the chosen project", async () => {
    const request = vi.fn(async (_scope, method, params) => {
      if (method === "importScan") return params.cursor ? { sessions: [candidate("existing", "already"), candidate("last")], nextCursor: null } : { sessions: [candidate("first")], nextCursor: "next" };
      if (method === "importSessions") return { imported: params.ids.map((sourceId: string) => ({ sourceId, conversationId: `copy-${sourceId}` })), skipped: [], failed: [] };
      return undefined;
      return undefined;
    });
    const { onImported } = mount(request); expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "导入本机会话" }));
    await screen.findByRole("checkbox", { name: "History first" });
    fireEvent.click(screen.getByRole("button", { name: "选择全部历史" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导入所选 (2)" })).toBeEnabled());
    expect(screen.getByRole("checkbox", { name: "History existing" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "导入到项目" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Project A" }));
    fireEvent.click(screen.getByRole("button", { name: "导入所选 (2)" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(scope, "importSessions", { provider: "codex", ids: ["first", "last"], projectId: "project-a" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("shows source errors and allows switching providers without importing anything", async () => {
    const request = vi.fn(async (_scope, method, params) => {
      if (method === "importScan" && params.provider === "codex") throw new Error("Update Codex to read history");
      return { sessions: [{ ...candidate("claude-source"), provider: "claude" }], nextCursor: null };
    });
    mount(request); fireEvent.click(screen.getByRole("button", { name: "导入本机会话" }));
    await screen.findByText("Update Codex to read history");
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    await screen.findByRole("checkbox", { name: "History claude-source" });
    expect(request.mock.calls.every(([, method]) => method === "importScan")).toBe(true);
  });
  it("keeps failed selections available for retry after a partial import", async () => {
    let imported = false;
    const request = vi.fn(async (_scope, method) => {
      if (method === "importScan") return { sessions: [candidate("good", imported ? "copy" : undefined), candidate("broken")], nextCursor: null };
      imported = true;
      return { imported: [{ sourceId: "good", conversationId: "copy" }], skipped: [], failed: [{ sourceId: "broken", error: "Original folder is missing" }] };
    });
    const { onImported } = mount(request); fireEvent.click(screen.getByRole("button", { name: "导入本机会话" }));
    await screen.findByRole("checkbox", { name: "History good" });
    fireEvent.click(screen.getByRole("checkbox", { name: "全选当前列表" }));
    fireEvent.click(screen.getByRole("button", { name: "导入所选 (2)" }));
    await screen.findByText(/Original folder is missing/);
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "导入所选 (1)" })).toBeEnabled();
    expect(onImported).toHaveBeenCalledOnce();
  });
  it("stops an in-flight batch and refreshes already persisted results", async () => {
    let rejectBatch: (error: Error) => void = () => {};
    const request = vi.fn(async (_scope, method) => {
      if (method === "importScan") return { sessions: [candidate("source")], nextCursor: null };
      if (method === "importSessions") return new Promise((_resolve, reject) => { rejectBatch = reject; });
      if (method === "importCancel") rejectBatch(new Error("Cancelled"));
      return undefined;
      return undefined;
    });
    const { onImported } = mount(request); fireEvent.click(screen.getByRole("button", { name: "导入本机会话" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "History source" }));
    fireEvent.click(screen.getByRole("button", { name: "导入所选 (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "停止导入" }));
    await screen.findByText("已停止，已完成的导入已保留。");
    expect(request).toHaveBeenCalledWith(scope, "importCancel", {});
    expect(onImported).toHaveBeenCalledOnce();
  });
  it("allows stopping selection while older metadata pages are loading", async () => {
    let rejectPage: (error: Error) => void = () => {};
    const request = vi.fn(async (_scope, method, params) => {
      if (method === "importScan" && !params.cursor) return { sessions: [candidate("first")], nextCursor: "next" };
      if (method === "importScan") return new Promise((_resolve, reject) => { rejectPage = reject; });
      if (method === "importCancel") rejectPage(new Error("Cancelled"));
      return undefined;
    });
    mount(request); fireEvent.click(screen.getByRole("button", { name: "导入本机会话" }));
    await screen.findByRole("checkbox", { name: "History first" });
    fireEvent.click(screen.getByRole("button", { name: "选择全部历史" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(scope, "importScan", { provider: "codex", cursor: "next" }));
    fireEvent.click(screen.getByRole("button", { name: "停止导入" }));
    await screen.findByText("已停止读取历史。");
    expect(request.mock.calls.some(([, method]) => method === "importSessions")).toBe(false);
  });
});
