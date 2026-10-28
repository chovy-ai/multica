// @vitest-environment node
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { SideBrowserController } from "./side-browser-controller";
vi.mock("electron", () => ({ nativeImage: { createFromBuffer: vi.fn(() => ({ isEmpty: () => false, getSize: () => ({ width: 2000, height: 1000 }), resize: () => ({ toJPEG: () => Buffer.alloc(100) }), toJPEG: () => Buffer.alloc(100) })) } }));
function setup() {
  const debuggerApi = Object.assign(new EventEmitter(), { attached: false, isAttached: () => debuggerApi.attached,
    attach: vi.fn(() => { debuggerApi.attached = true; }), detach: vi.fn(() => { debuggerApi.attached = false; }),
    sendCommand: vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<any> => {
      if (method === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "1", role: { value: "button" }, name: { value: "Search" }, backendDOMNodeId: 7 }] };
      if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } };
      if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 2000, height: 1000 }, cssLayoutViewport: { clientWidth: 1000, clientHeight: 600 } };
      if (method === "Page.captureScreenshot") return { data: Buffer.alloc(100).toString("base64") };
      return {};
    }),
  });
  const contents = Object.assign(new EventEmitter(), { debugger: debuggerApi, isDestroyed: () => false, getBackgroundThrottling: () => true, setBackgroundThrottling: vi.fn(), getURL: () => "https://example.test", getTitle: () => "Page", isLoading: () => false });
  const activity = vi.fn(), controller = new SideBrowserController(activity);
  const run = (action: Parameters<typeof controller.run>[4], turnId = "turn") => controller.run("web:one", contents as unknown as WebContents, "main", turnId, action, new AbortController().signal);
  return { controller, contents, debuggerApi, activity, run };
}
describe("bounded Side browser control", () => {
  it("uses AX refs, dispatches an actual input action, and returns a new snapshot", async () => {
    const { run, debuggerApi, controller } = setup();
    const snapshot = await run({ type: "snapshot" }) as any;
    expect(snapshot).toMatchObject({ untrusted_page_content: true, nodes: [{ name: "Search" }] });
    const result = await run({ type: "click", ref: snapshot.nodes[0].ref });
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.objectContaining({ type: "mousePressed", x: 50, y: 20 }));
    expect(result).toMatchObject({ status: "applied", snapshot: { untrusted_page_content: true } });
    await expect(run({ type: "click", ref: snapshot.nodes[0].ref })).rejects.toThrow("stale_ref");
    controller.dispose();
  });
  it("rejects competing turns and navigation-invalidated refs", async () => {
    const { run, debuggerApi, controller } = setup();
    const snapshot = await run({ type: "snapshot" }) as any;
    await expect(run({ type: "snapshot" }, "another-turn")).rejects.toThrow("tab_busy");
    debuggerApi.emit("message", {}, "Page.frameNavigated", { frame: { id: "main-frame" } });
    await expect(run({ type: "type", ref: snapshot.nodes[0].ref, text: "hello" })).rejects.toThrow("stale_ref");
    controller.dispose();
  });
  it("aborts active commands when tabs close, detaches and permits another turn", async () => {
    const { run, debuggerApi, controller, contents, activity } = setup();
    await run({ type: "snapshot" });
    const original = debuggerApi.sendCommand.getMockImplementation()!;
    debuggerApi.sendCommand.mockImplementation((method, params) => method === "Accessibility.getFullAXTree" ? new Promise(() => {}) : original(method, params));
    const pending = run({ type: "snapshot" });
    controller.reconcile("main", new Set());
    await expect(pending).rejects.toThrow("ended");
    expect(debuggerApi.detach).toHaveBeenCalledOnce(); expect(contents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    expect(activity).toHaveBeenLastCalledWith("web:one", "main", "turn", false);
    debuggerApi.sendCommand.mockImplementation(original);
    await expect(run({ type: "snapshot" }, "next-turn")).resolves.toMatchObject({ untrusted_page_content: true });
    controller.dispose();
  });
  it("recovers after debugger detach and bounds screenshots below daemon message size", async () => {
    const { run, controller, debuggerApi } = setup();
    await run({ type: "snapshot" });
    debuggerApi.attached = false; debuggerApi.emit("detach", {}, "target_closed");
    const screenshot = await run({ type: "screenshot", fullPage: true }) as any;
    expect(screenshot.image.mimeType).toBe("image/jpeg"); expect(JSON.stringify(screenshot).length).toBeLessThan(1 << 20);
    expect(debuggerApi.attach).toHaveBeenCalledTimes(2);
    controller.release("main", "turn");
  });
});
