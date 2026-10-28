// @vitest-environment jsdom
import { act, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsageIndicator } from "./usage-indicator";
import type { AgentGuiRpcClient } from "./protocol";
import type { LocalProviderUsage } from "./local-protocol";

vi.mock("@tutti-os/ui-system/components", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Popover: ({ children }: PropsWithChildren) => <>{children}</>,
  PopoverTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  PopoverContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const usage: LocalProviderUsage = { provider: "claude", context: { usedTokens: 900, limitTokens: 1000, model: null, updatedAt: null },
  account: { status: "unavailable", windows: [], plan: null, updatedAt: null }, compaction: { status: "ready" } };
function setup() {
  let finish!: () => void, fail!: (error: Error) => void;
  const request = vi.fn(async (method: string) => {
    if (method === "session.compact") return new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    if (method === "usage.read") return usage;
    throw new Error(method);
  });
  const client = { request, subscribe: () => () => {} } as unknown as AgentGuiRpcClient;
  const render = (sessionId: string | null = "first", busy = false) => act(async () => root.render(<UsageIndicator client={client} agentId="local:claude" sessionId={sessionId} chinese={false} busy={busy} active />));
  const button = () => container.querySelector<HTMLButtonElement>('[aria-label="Compact context"]')!;
  return { request, render, button, finish: () => finish(), fail: () => fail(new Error("Provider disconnected")) };
}
it("shows pending state, blocks repeated clicks and refreshes usage after compaction", async () => {
  const f = setup(); await f.render();
  await act(async () => { f.button().click(); f.button().click(); });
  expect(f.request.mock.calls.filter(([method]) => method === "session.compact")).toHaveLength(1);
  expect(f.button().disabled).toBe(true);
  expect(container.textContent).toContain("Compacting context");
  await act(async () => f.finish());
  expect(f.request).toHaveBeenLastCalledWith("usage.read", expect.objectContaining({ sessionId: "first", force: true }));
  expect(container.textContent).toContain("Context compacted");
  expect(f.button().disabled).toBe(false);
});
it("shows provider errors and enables an explicit retry", async () => {
  const f = setup(); await f.render();
  await act(async () => f.button().click());
  await act(async () => f.fail());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Provider disconnected");
  expect(f.button().disabled).toBe(false);
});
it("does not show an old operation's result or usage in a newly selected conversation", async () => {
  const f = setup(); await f.render();
  await act(async () => f.button().click());
  await f.render("second");
  const reads = f.request.mock.calls.filter(([method]) => method === "usage.read").length;
  await act(async () => f.finish());
  expect(container.textContent).not.toContain("Context compacted");
  expect(f.request.mock.calls.filter(([method]) => method === "usage.read")).toHaveLength(reads);
  expect(f.button().disabled).toBe(false);
});
it("disables compaction while sending and before a session exists", async () => {
  const f = setup(); await f.render("first", true);
  expect(f.button().disabled).toBe(true);
  await f.render(null);
  expect(f.button().disabled).toBe(true);
});
