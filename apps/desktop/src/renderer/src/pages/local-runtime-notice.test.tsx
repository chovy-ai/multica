import { act, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LocalHostAvailability } from "../../../shared/local-host-availability";
import { LocalRuntimeNotice } from "./local-runtime-notice";

let qc: QueryClient;
afterEach(() => { cleanup(); qc.clear(); });
const wrap = (children: ReactNode) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
const scope = { userId: "user", workspaceId: "workspace" };
function setup(legacy: boolean, availability: LocalHostAvailability | null = { state: "connected" }) {
  const listeners = new Set<(value: LocalHostAvailability) => void>();
  qc = new QueryClient();
  // A daemon older than the local v2 API answers its routes with 404.
  const request = vi.fn(async () => {
    if (legacy) throw new Error("http_404: Local conversation request failed (HTTP 404)");
    return { providers: [] };
  });
  const localHost = { availability: vi.fn(async () => availability), subscribe: (listener: (value: LocalHostAvailability) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { localV2: { request, send: vi.fn(), subscribe: () => () => {}, onConnection: () => () => {} }, localHost } });
  return Object.assign(request, { publish: (value: LocalHostAvailability) => listeners.forEach((listener) => listener(value)) });
}
it("keeps an actionable restart notice visible without remounting or clearing the conversation", async () => {
  const request = setup(true);
  const view = render(wrap(<><LocalRuntimeNotice scope={scope} chinese /><textarea aria-label="Draft" defaultValue="Keep my draft" /></>));
  expect(await screen.findByRole("alert")).toHaveTextContent("完全退出并重新打开 Multica");
  expect(screen.getByRole("alert")).toHaveTextContent("运行中的任务结束后");
  const draft = screen.getByRole("textbox");
  view.rerender(wrap(<><LocalRuntimeNotice scope={scope} chinese /><textarea aria-label="Draft" defaultValue="Keep my draft" /></>));
  expect(screen.getByRole("textbox")).toBe(draft); expect(draft).toHaveValue("Keep my draft");
  expect(request).toHaveBeenCalledOnce();
});
it("renders no warning with a compatible backend", async () => {
  const request = setup(false);
  render(wrap(<LocalRuntimeNotice scope={scope} chinese={false} />));
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("explains why local conversations are unavailable and clears once the daemon connects", async () => {
  const request = setup(false, { state: "unavailable", reason: "daemon_offline" });
  render(wrap(<LocalRuntimeNotice scope={scope} chinese />));
  expect(await screen.findByRole("alert")).toHaveTextContent("本机守护进程未运行");
  act(() => request.publish({ state: "unavailable", reason: "unsupported" }));
  expect(screen.getByRole("alert")).toHaveTextContent("WSL 或单独安装的 CLI 不支持");
  act(() => request.publish({ state: "connected" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
