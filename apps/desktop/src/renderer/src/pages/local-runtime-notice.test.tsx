import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LOCAL_CONVERSATION_METHODS } from "@multica/core/local-conversation/protocol";
import { LocalRuntimeNotice } from "./local-runtime-notice";

afterEach(cleanup);
const scope = { userId: "user", workspaceId: "workspace" };
function setup(legacy: boolean) {
  const request = vi.fn(async () => {
    if (legacy) throw new Error("Unknown local conversation request");
    return { protocolVersion: 1, methods: Object.keys(LOCAL_CONVERSATION_METHODS) };
  });
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { localConversations: { request, subscribe: () => () => {} } } });
  return request;
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
