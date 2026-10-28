// @vitest-environment jsdom
import { act, type ButtonHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SideEntryProvider } from "./side-entry";
import type { AgentGuiRpcClient } from "./protocol";

vi.mock("@tutti-os/ui-system", () => ({ DropdownMenuItem: () => null }));
vi.mock("@multica/ui/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, "aria-busy": busy }: ButtonHTMLAttributes<HTMLButtonElement>) =>
    <button onClick={onClick} disabled={disabled} aria-busy={busy}>{children}</button>,
}));

let container: HTMLDivElement;
let root: Root;
const request = vi.fn<AgentGuiRpcClient["request"]>();
const writeText = vi.fn<(text: string) => Promise<void>>();
const client: AgentGuiRpcClient = { request, subscribe: () => () => {} };
const handle = {} as Parameters<typeof SideEntryProvider>[0]["handle"];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

async function mount(chinese = true) {
  await act(async () => root.render(
    <SideEntryProvider client={client} handle={handle} sessionId="session-a" chinese={chinese} enabled>
      <article data-multica-turn-id="turn-a"><p>Selected reply text</p></article>
    </SideEntryProvider>,
  ));
}

async function select() {
  const range = document.createRange();
  range.selectNodeContents(container.querySelector("p")!);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => document.dispatchEvent(new Event("pointerup", { bubbles: true })));
}

async function click(index: number) {
  await act(async () => container.querySelectorAll("button")[index]!.click());
}

async function expectDismissed() {
  expect(container.querySelector('[role="toolbar"]')).toBeNull();
  expect(window.getSelection()!.rangeCount).toBe(0);
  await act(async () => {
    document.dispatchEvent(new Event("pointerup"));
    document.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
  });
  expect(container.querySelector('[role="toolbar"]')).toBeNull();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(100, 100, 200, 20) });
  vi.stubGlobal("navigator", Object.create(navigator, { clipboard: { value: { writeText } } }));
  request.mockReset().mockResolvedValue(undefined);
  writeText.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  window.getSelection()?.removeAllRanges();
  container.remove();
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([[true, "复制成功"], [false, "Copied successfully"]] as const)("dismisses immediately and reports copy success after writing (Chinese: %s)", async (chinese, message) => {
  const copy = deferred();
  writeText.mockReturnValue(copy.promise);
  await mount(chinese);
  await select();
  await click(0);
  expect(writeText).toHaveBeenCalledExactlyOnceWith("Selected reply text");
  await expectDismissed();
  expect(request).not.toHaveBeenCalled();
  await act(async () => copy.resolve());
  expect(request).toHaveBeenCalledExactlyOnceWith("host.showMessage", { message, tone: "info" });
  await select();
  expect(container.querySelector('[role="toolbar"]')).not.toBeNull();
});

it.each([[true, "无法复制文字，请重试"], [false, "Could not copy text. Try again."]] as const)("reports a failed copy without success feedback (Chinese: %s)", async (chinese, message) => {
  writeText.mockRejectedValue(new Error("Clipboard denied"));
  await mount(chinese);
  await select();
  await click(0);
  await expectDismissed();
  expect(request).toHaveBeenCalledExactlyOnceWith("host.showMessage", { message, tone: "error" });
});

it.each(["resolve", "reject"] as const)("dismisses before a side request completes and preserves pending protection (%s)", async (result) => {
  const side = deferred();
  request.mockImplementation((method) => method === "host.openSide" ? side.promise : Promise.resolve(undefined));
  await mount();
  await select();
  await click(1);
  await expectDismissed();
  expect(request).toHaveBeenCalledExactlyOnceWith("host.openSide", {
    sessionId: "session-a", turnId: "turn-a", quote: "Selected reply text", requestId: expect.any(String),
  });
  await select();
  expect(container.querySelectorAll("button")[1]!.disabled).toBe(true);
  await click(1);
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => {
    if (result === "reject") side.reject(new Error("Side unavailable"));
    else side.resolve();
  });
  expect(container.querySelectorAll("button")[1]!.disabled).toBe(false);
  if (result === "reject") expect(request).toHaveBeenLastCalledWith("host.showMessage", { message: "Side unavailable", tone: "error" });
  else expect(request).toHaveBeenCalledTimes(1);
});
