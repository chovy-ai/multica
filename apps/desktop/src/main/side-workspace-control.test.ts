// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { SideWorkspaceControl } from "./side-workspace-control";
import type { SideWorkspaceCommand } from "../shared/side-workspace";
vi.mock("electron", () => ({ nativeImage: {} }));
const scope = { userId: "user", workspaceId: "workspace" };
function setup() {
  const snapshot = { conversationId: "main", revision: 1, panelOpen: true, visible: true, selectedTabId: "web:user", tabs: [{ id: "web:user", kind: "web" as const, url: "https://example.test" }] };
  const sent: SideWorkspaceCommand[] = [];
  const controller = new SideWorkspaceControl({ currentUser: () => "user", snapshot: async () => snapshot, assertTurn: async () => {}, preview: vi.fn(), send: (value) => { sent.push(value); }, activity: vi.fn() });
  return { controller, snapshot, sent };
}
describe("Side main-process boundary", () => {
  it("rejects foreign owners and tabs before changing the UI", async () => {
    const { controller, sent } = setup();
    await expect(controller.handle({ op: "select", scope: { ...scope, userId: "foreign" }, conversationId: "main", turnId: "turn", tabId: "web:user" }, new AbortController().signal)).rejects.toThrow("account");
    await expect(controller.handle({ op: "select", scope, conversationId: "main", turnId: "turn", tabId: "web:foreign" }, new AbortController().signal)).rejects.toThrow("not_in_current_side");
    expect(sent).toEqual([]);
  });
  it("cannot close a user tab and returns unknown when renderer acknowledgement times out", async () => {
    vi.useFakeTimers();
    const { controller } = setup();
    try {
      await expect(controller.handle({ op: "close", scope, conversationId: "main", turnId: "turn", tabId: "web:user" }, new AbortController().signal)).rejects.toThrow("User tabs");
      const pending = controller.handle({ op: "select", scope, conversationId: "main", turnId: "turn", tabId: "web:user" }, new AbortController().signal);
      const result = expect(pending).rejects.toThrow("unknown");
      await vi.advanceTimersByTimeAsync(3001); await result;
    } finally { controller.dispose(); vi.useRealTimers(); }
  });
  it("does not acquire browser control after a turn is released while waiting for the renderer", async () => {
    const { controller, snapshot, sent } = setup();
    const browser = vi.spyOn(controller.browser, "run");
    const request = { op: "browser", scope, conversationId: "main", turnId: "turn", tabId: "web:user", action: { type: "snapshot" } };
    const pending = controller.handle(request, new AbortController().signal);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const released = controller.handle({ op: "release", scope, conversationId: "main", turnId: "turn" }, new AbortController().signal);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    controller.ack({ id: sent[1]!.id, snapshot }); await released;
    const rejection = expect(pending).rejects.toThrow("ended");
    controller.ack({ id: sent[0]!.id, snapshot, tabId: "web:user" }); await rejection;
    expect(browser).not.toHaveBeenCalled(); controller.dispose();
  });
  it("waits for scoped acknowledgements and reuses the same mutation receipt", async () => {
    const { controller, snapshot, sent } = setup();
    const request = { op: "select", scope, conversationId: "main", turnId: "turn", tabId: "web:user", requestId: "one" };
    const first = controller.handle(request, new AbortController().signal);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    controller.ack({ id: sent[0]!.id, snapshot, tabId: "web:user" });
    expect(await first).toMatchObject({ tabId: "web:user" });
    expect(await controller.handle(request, new AbortController().signal)).toEqual(await first);
    expect(sent).toHaveLength(1); controller.dispose();
  });
});
