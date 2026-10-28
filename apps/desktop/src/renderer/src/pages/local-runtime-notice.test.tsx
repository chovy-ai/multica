import { act, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LOCAL_CONVERSATION_METHODS, LOCAL_CONVERSATION_PROTOCOL_VERSION } from "@multica/core/local-conversation/protocol";
import type { LocalHostAvailability } from "../../../shared/local-host-availability";
import { LocalRuntimeNotice } from "./local-runtime-notice";

afterEach(cleanup);
const scope = { userId: "user", workspaceId: "workspace" };
function setup(legacy: boolean, availability: LocalHostAvailability | null = { state: "connected", sidecar: "ready" }) {
  const listeners = new Set<(value: LocalHostAvailability) => void>();
  const request = vi.fn(async () => {
    if (legacy) throw new Error("Unknown local conversation request");
    return { protocolVersion: LOCAL_CONVERSATION_PROTOCOL_VERSION, methods: Object.keys(LOCAL_CONVERSATION_METHODS) };
  });
  const localHost = { availability: vi.fn(async () => availability), subscribe: (listener: (value: LocalHostAvailability) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { localConversations: { request, subscribe: () => () => {} }, localHost } });
  return Object.assign(request, { publish: (value: LocalHostAvailability) => listeners.forEach((listener) => listener(value)) });
}
it("keeps an actionable restart notice visible without remounting or clearing the conversation", async () => {
  const request = setup(true);
  const view = render(<><LocalRuntimeNotice scope={scope} chinese /><textarea aria-label="Draft" defaultValue="Keep my draft" /></>);
  expect(await screen.findByRole("alert")).toHaveTextContent("完全退出并重新打开 Multica");
  expect(screen.getByRole("alert")).toHaveTextContent("运行中的任务结束后");
  const draft = screen.getByRole("textbox");
  view.rerender(<><LocalRuntimeNotice scope={scope} chinese /><textarea aria-label="Draft" defaultValue="Keep my draft" /></>);
  expect(screen.getByRole("textbox")).toBe(draft); expect(draft).toHaveValue("Keep my draft");
  expect(request).toHaveBeenCalledOnce();
});
it("renders no warning with a compatible backend", async () => {
  const request = setup(false);
  render(<LocalRuntimeNotice scope={scope} chinese={false} />);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("explains why local conversations are unavailable and clears once the daemon connects", async () => {
  const request = setup(false, { state: "unavailable", reason: "daemon_offline" });
  render(<LocalRuntimeNotice scope={scope} chinese />);
  expect(await screen.findByRole("alert")).toHaveTextContent("本机守护进程未运行");
  act(() => request.publish({ state: "unavailable", reason: "unsupported" }));
  expect(screen.getByRole("alert")).toHaveTextContent("WSL 或单独安装的 CLI 不支持");
  act(() => request.publish({ state: "connected", sidecar: "ready" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
