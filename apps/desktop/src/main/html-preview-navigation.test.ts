// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { installHtmlPreviewNavigationGuard } from "./html-preview-navigation";

it("blocks self-navigation and child navigation from HTML previews without blocking the GUI", () => {
  const contents = { on: vi.fn() };
  installHtmlPreviewNavigationGuard(contents as unknown as WebContents);
  expect(contents.on).toHaveBeenCalledWith("will-frame-navigate", expect.any(Function));
  const listener = contents.on.mock.calls[0]![1];
  for (const [url, frame, initiator, blocked] of [
    ["https://example.test/?data=private", "about:srcdoc", null, true],
    ["file:///etc/passwd", "about:srcdoc", null, true],
    ["about:blank", "about:srcdoc", null, true],
    ["https://example.test", "about:blank", "about:srcdoc", true],
    ["about:srcdoc", "about:blank", "http://localhost:16099/tutti-agent-gui/index.html", false],
    ["http://localhost:16099/tutti-agent-gui/index.html", "about:blank", null, false],
  ] as const) {
    const preventDefault = vi.fn();
    listener({ url, frame: { url: frame }, initiator: initiator ? { url: initiator } : null, preventDefault });
    expect(preventDefault.mock.calls.length > 0, url).toBe(blocked);
  }
});
