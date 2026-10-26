import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentGuiPreviewHost } from "./agent-gui-preview-host";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); }) });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.removeAttribute("open"); }) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  const iframe = createRef<HTMLIFrameElement>();
  let activeScope = true;
  const current = () => activeScope;
  const content = (enabled = true) => <AgentGuiPreviewHost iframe={iframe} enabled={enabled} isCurrent={current}><iframe ref={iframe} title="GUI" /></AgentGuiPreviewHost>;
  const view = render(content());
  const frame = iframe.current!;
  const message = (overrides: MessageEventInit = {}) => act(() => {
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: location.origin, data: { type: "multica:agent-gui:preview-state", version: 1, expanded: true }, ...overrides }));
  });
  return { ...view, frame, message, content, changeScope: () => { activeScope = false; } };
}
it("accepts preview state only from the owning frame, origin, supported packet and current scope", () => {
  const { message, changeScope } = setup();
  message({ source: window });
  message({ origin: "https://untrusted.invalid" });
  message({ data: { type: "multica:agent-gui:preview-state", version: 2, expanded: true } });
  message({ data: { type: "multica:agent-gui:preview-state", version: 1, expanded: "true" } });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  changeScope(); message();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("promotes the same frame and sends Escape back to its preview", () => {
  const { frame, message } = setup();
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  message();
  const dialog = screen.getByRole("dialog", { name: "SVG" });
  expect(dialog).toHaveAttribute("open");
  expect(screen.getByTitle("GUI")).toBe(frame);
  fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(post).toHaveBeenCalledWith({ type: "multica:agent-gui:preview-close", version: 1 }, location.origin);
  message();
  expect(screen.getByRole("dialog")).toBeVisible();
  fireEvent.load(frame);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("closes a hidden host and rejects subsequent expansion while keeping its frame mounted", () => {
  const { frame, message, rerender, content } = setup();
  message(); expect(screen.getByRole("dialog")).toBeVisible();
  rerender(content(false));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  message();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByTitle("GUI")).toBe(frame);
});
