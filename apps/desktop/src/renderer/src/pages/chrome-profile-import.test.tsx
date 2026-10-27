import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChromeProfileImportResult, ResourcePreviewClient } from "../../../shared/resource-preview";
import { ChromeProfileImport } from "./chrome-profile-import";

const scope = { userId: "fixture-user", workspaceId: "fixture-workspace" };
let client: ResourcePreviewClient;
let queryClient: QueryClient;
beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client = {
    request: vi.fn(), subscribe: () => () => {},
    listChromeProfiles: vi.fn(async () => ({ status: "available" as const, profiles: [{ id: "first", name: "Personal" }, { id: "second", name: "Work", email: "fixture@example.test" }] })),
    importChromeProfile: vi.fn(async () => ({ status: "success" as const, imported: 4, failed: 0, skipped: 0 })),
    cancelChromeProfileImport: vi.fn(async () => true),
  };
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { resourcePreview: client } });
});
afterEach(() => { cleanup(); queryClient.clear(); });
function setup(chinese = false) {
  return render(<QueryClientProvider client={queryClient}><ChromeProfileImport scope={scope} previewId="web-one" chinese={chinese} /></QueryClientProvider>);
}

it("waits for an explicit selection and import, reports success, and returns focus to the opener", async () => {
  setup();
  expect(client.listChromeProfiles).not.toHaveBeenCalled();
  const opener = screen.getByRole("button", { name: "Import Chrome profile" });
  fireEvent.click(opener);
  fireEvent.click(await screen.findByRole("radio", { name: /Work/ }));
  expect(client.importChromeProfile).not.toHaveBeenCalled();
  expect(screen.getByRole("radio", { name: /Work/ })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  expect(await screen.findByText("Imported 4 cookies; 0 skipped; 0 failed.")).toBeVisible();
  expect(client.importChromeProfile).toHaveBeenCalledWith(scope, { id: "web-one", profileId: "second", requestId: expect.any(String) });
  fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(opener).toHaveFocus());
});

it("shows a useful empty/unsupported state and never enables import", async () => {
  vi.mocked(client.listChromeProfiles).mockResolvedValue({ status: "unavailable", reason: "unsupported-platform" });
  setup(true);
  fireEvent.click(screen.getByRole("button", { name: "导入 Chrome 配置" }));
  expect(await screen.findByText("目前仅支持 macOS 上的 Chrome Stable。")).toBeVisible();
  expect(screen.getByRole("button", { name: "导入" })).toBeDisabled();
  expect(client.importChromeProfile).not.toHaveBeenCalled();
});

it("shows partial counts and keeps the selection for a denied authorization retry", async () => {
  vi.mocked(client.importChromeProfile).mockResolvedValueOnce({ status: "partial", imported: 2, skipped: 3, failed: 1 });
  setup(true);
  fireEvent.click(screen.getByRole("button", { name: "导入 Chrome 配置" }));
  fireEvent.click(await screen.findByRole("radio", { name: /Work/ }));
  fireEvent.click(screen.getByRole("button", { name: "导入" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("部分导入成功。已导入 2 项 Cookie，跳过 3 项，失败 1 项。");
  vi.mocked(client.importChromeProfile).mockResolvedValueOnce({ status: "failed", code: "keychain_denied", imported: 0, skipped: 0, failed: 0 });
  fireEvent.click(screen.getByRole("button", { name: "导入" }));
  expect(await screen.findByText("钥匙串访问被拒绝。请重试，并允许访问 Chrome Safe Storage。")).toBeVisible();
  expect(screen.getByRole("radio", { name: /Work/ })).toBeChecked();
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("prevents duplicate submits and sends a matching cancellation receipt before closing", async () => {
  let finish!: (result: ChromeProfileImportResult) => void;
  vi.mocked(client.importChromeProfile).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Import Chrome profile" }));
  await screen.findByRole("radio", { name: "Personal" });
  const submit = screen.getByRole("button", { name: "Import" });
  fireEvent.click(submit); fireEvent.click(submit);
  await waitFor(() => expect(client.importChromeProfile).toHaveBeenCalledOnce());
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
  const requestId = vi.mocked(client.importChromeProfile).mock.calls[0]![1].requestId;
  await waitFor(() => expect(client.cancelChromeProfileImport).toHaveBeenCalledWith(scope, requestId));
  await act(async () => { finish({ status: "canceled", imported: 0, failed: 0, skipped: 0 }); });
  expect(await screen.findByText("Import canceled. No cookies were written.")).toBeVisible();
});

it("cancels outstanding preparation when its preview unmounts", async () => {
  vi.mocked(client.importChromeProfile).mockImplementation(() => new Promise(() => {}));
  const view = setup();
  fireEvent.click(screen.getByRole("button", { name: "Import Chrome profile" }));
  await screen.findByRole("radio", { name: "Personal" });
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(client.importChromeProfile).toHaveBeenCalledOnce());
  view.unmount();
  expect(client.cancelChromeProfileImport).toHaveBeenCalledWith(scope, vi.mocked(client.importChromeProfile).mock.calls[0]![1].requestId);
});
