import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TuttiAgentGuiPanel } from "./tutti-agent-gui-panel";
import { NavigationProvider } from "../navigation";

const mock = vi.hoisted(() => ({ foreground: true, create: vi.fn(), services: [] as Array<{ load: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn>; publish: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> }));
vi.mock("./parent-service", () => ({ createAgentGuiParentService: mock.create }));
vi.mock("@multica/core/auth", () => ({ useAuthStore: { getState: () => ({ user: { id: "user" } }) } }));
vi.mock("@multica/core/platform", () => ({ getCurrentSlug: () => "acme", getCurrentWsId: () => "ws" }));
vi.mock("@multica/core/realtime", () => ({ useWSReconnect: () => {} }));
vi.mock("../common/use-app-foreground", () => ({ useAppForeground: () => mock.foreground }));
vi.mock("@multica/ui/components/common/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../i18n", () => ({ useLocale: () => "en", useT: () => ({ t: (selector: (value: unknown) => string) => selector({ workbench: { title: "Agent GUI", loading: "Loading", load_error: "Failed", retry: "Retry" } }) }) }));

class Port {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn();
}
const channels: Array<{ port1: Port; port2: Port }> = [];
const props = { workspaceId: "ws", workspaceSlug: "acme", userId: "user", activeSessionId: null,
  active: true, onRestoreDraftApplied: vi.fn(), onSelectSession: vi.fn(), onOpenTask: vi.fn(), onShowMessage: vi.fn() };
const clients: QueryClient[] = [];
function TestProvider({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient());
  clients.push(qc);
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
async function ready(origin = window.location.origin, source?: Window | null, rendered = true) {
  const frame = screen.getByTitle("Agent GUI") as HTMLIFrameElement;
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { source: source === undefined ? frame.contentWindow : source,
      origin, data: { type: "multica:agent-gui:ready", version: 1 } }));
  });
  if (rendered) await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { source: source === undefined ? frame.contentWindow : source,
      origin, data: { type: "multica:agent-gui:rendered", version: 1 } }));
  });
  return frame;
}

beforeEach(() => {
  mock.foreground = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => mock.foreground);
  mock.services.length = 0; channels.length = 0;
  mock.create.mockReset();
  mock.create.mockImplementation(() => {
    const service = { load: vi.fn().mockResolvedValue({ agents: [], sessions: [] }), request: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn(), dispose: vi.fn(), subscribe: () => () => {}, reconnect: vi.fn() };
    mock.services.push(service);
    return service;
  });
  vi.stubGlobal("MessageChannel", class { port1 = new Port(); port2 = new Port(); constructor() { channels.push(this); } });
});
afterEach(() => { cleanup(); clients.splice(0).forEach((qc) => qc.clear()); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("isolated Agent GUI document lifetime", () => {
  it("dismisses child popovers on host pointer actions without intercepting the host action or leaking listeners", async () => {
    const view = render(<TuttiAgentGuiPanel {...props} />, { wrapper: TestProvider });
    const frame = await ready();
    const port = channels[0]!.port1;
    port.postMessage.mockClear();
    expect(fireEvent.pointerDown(document.body)).toBe(true);
    expect(port.postMessage).toHaveBeenCalledWith({ type: "event", event: { type: "dismissPopovers" } });
    port.postMessage.mockClear();
    fireEvent.pointerDown(frame);
    expect(port.postMessage).not.toHaveBeenCalled();
    await act(async () => { view.rerender(<TuttiAgentGuiPanel {...props} active={false} />); });
    port.postMessage.mockClear(); fireEvent.pointerDown(document.body);
    expect(port.postMessage).not.toHaveBeenCalled();
    view.unmount(); port.postMessage.mockClear(); fireEvent.pointerDown(document.body);
    expect(port.postMessage).not.toHaveBeenCalled();
  });
  it("keeps initialization covered until its own document has rendered the restored view", async () => {
    render(<TuttiAgentGuiPanel {...props} />, { wrapper: TestProvider });
    const frame = await ready(window.location.origin, undefined, false);
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent("Loading");
    const rendered = (source: Window | null, origin = window.location.origin) => window.dispatchEvent(new MessageEvent("message", {
      source, origin, data: { type: "multica:agent-gui:rendered", version: 1 },
    }));
    await act(async () => { rendered(window); rendered(frame.contentWindow, "https://other.invalid"); });
    expect(screen.getByRole("status", { hidden: true })).toBeInTheDocument();
    await act(async () => { rendered(frame.contentWindow); });
    expect(screen.queryByRole("status", { hidden: true })).not.toBeInTheDocument();
  });
  it("offers retry if restoring the view stalls after a successful handshake", async () => {
    vi.useFakeTimers();
    render(<TuttiAgentGuiPanel {...props} />, { wrapper: TestProvider });
    await ready(window.location.origin, undefined, false);
    await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent("Failed");
    expect(screen.getByRole("button", { name: "Retry", hidden: true })).toBeInTheDocument();
  });
  it.each([false, true])("routes resource mentions through the %s desktop navigation adapter", async (desktop) => {
    const push = vi.fn(); const openInNewTab = vi.fn();
    const adapter = { push, replace: vi.fn(), back: vi.fn(), pathname: "/acme/conversations", searchParams: new URLSearchParams(), hash: "",
      getShareableUrl: (path: string) => `https://app.example.test${path}`, ...(desktop ? { openInNewTab } : {}) };
    render(<NavigationProvider value={adapter}><TuttiAgentGuiPanel {...props} /></NavigationProvider>, { wrapper: TestProvider });
    await ready();
    const options = mock.create.mock.calls[0]![0];
    expect(options.getAppOrigin()).toBe("https://app.example.test");
    expect(channels[0]!.port1.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    await act(async () => { options.onOpenInternalResource("/acme/agents/agent-id", false); options.onOpenInternalResource("/acme/issues/TES-124#comment-1", true); });
    if (desktop) {
      expect(openInNewTab.mock.calls).toEqual([["/acme/agents/agent-id", undefined, { activate: true }], ["/acme/issues/TES-124#comment-1", undefined, { activate: false }]]);
      expect(push).not.toHaveBeenCalled();
    } else expect(push.mock.calls).toEqual([["/acme/agents/agent-id"], ["/acme/issues/TES-124#comment-1"]]);
  });
  it("forwards an explicit new-conversation focus intent without replacing the source document", async () => {
    const view = render(<TuttiAgentGuiPanel {...props} />, { wrapper: TestProvider });
    await ready();
    const document = screen.getByTitle("Agent GUI");
    await act(async () => { view.rerender(<TuttiAgentGuiPanel {...props} activeSessionId="created" composerFocusSequence={1} />); });
    expect(mock.services[0]!.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "init", snapshot: expect.objectContaining({ activeSessionId: "created", composerFocusSequence: 1 }),
    }));
    expect(screen.getByTitle("Agent GUI")).toBe(document);
    expect(channels).toHaveLength(1);
  });
  it("checks actual focus for a command arriving before the foreground hook refreshes", async () => {
    mock.foreground = false;
    render(<TuttiAgentGuiPanel {...props} />, { wrapper: TestProvider });
    await ready();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await act(async () => {
      channels[0]!.port1.onmessage!(new MessageEvent("message", { data: { type: "request", id: "focused-send", method: "session.send", params: { sessionId: "session", content: "hello" } } }));
    });
    expect(mock.services[0]!.request).toHaveBeenCalledWith("session.send", { sessionId: "session", content: "hello" });
    expect(channels[0]!.port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "response", id: "focused-send" }));
  });

  it.each([false, true])("continues scoped image reads when the host is unfocused or hidden=%s", async (hidden) => {
    mock.foreground = false;
    render(<TuttiAgentGuiPanel {...props} active={!hidden} />, { wrapper: TestProvider });
    await ready();
    const params = { sessionId: "session", path: "/multica-local-images/image/generated.png" };
    await act(async () => {
      channels[0]!.port1.onmessage!(new MessageEvent("message", { data: { type: "request", id: "background-image", method: "image.read", params } }));
    });
    expect(mock.services[0]!.request).toHaveBeenCalledWith("image.read", params);
    expect(channels[0]!.port1.postMessage).toHaveBeenCalledWith({ type: "response", id: "background-image", result: undefined });
  });

  it("keeps an exposed window visible without OS focus while rejecting background writes", async () => {
    mock.foreground = false;
    const view = render(<TuttiAgentGuiPanel {...props} />, { wrapper: TestProvider });
    const frame = screen.getByTitle("Agent GUI") as HTMLIFrameElement;
    const connect = vi.spyOn(frame.contentWindow!, "postMessage");
    await ready();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ hostActive: false, hostVisible: true }),
    }), window.location.origin, expect.any(Array));
    const port = channels[0]!.port1;
    port.onmessage!(new MessageEvent("message", { data: { type: "request", id: "unfocused-send", method: "session.send", params: { sessionId: "session", content: "hello" } } }));
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "unfocused-send", error: expect.objectContaining({ code: "inactive_host" }) }));
    expect(mock.services[0]!.request).not.toHaveBeenCalled();
    await act(async () => { view.rerender(<TuttiAgentGuiPanel {...props} active={false} />); });
    expect(mock.services[0]!.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "init", snapshot: expect.objectContaining({ hostActive: false, hostVisible: false }),
    }));
    mock.foreground = true;
    await act(async () => { view.rerender(<TuttiAgentGuiPanel {...props} />); });
    expect(mock.services[0]!.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "init", snapshot: expect.objectContaining({ hostActive: true, hostVisible: true }),
    }));
    expect(channels).toHaveLength(1);
  });

  it.each(["unfocused", "hidden"])("continues queued sends when the host is %s", async (state) => {
    const view = render(<TuttiAgentGuiPanel {...props} />, { wrapper: TestProvider });
    const frame = await ready();
    const source = frame.src;
    mock.foreground = false;
    await act(async () => { view.rerender(<TuttiAgentGuiPanel {...props} active={state !== "hidden"} />); });
    const params = { sessionId: "session", content: "already queued", queued: true };
    await act(async () => {
      channels[0]!.port1.onmessage!(new MessageEvent("message", { data: { type: "request", id: "queued-send", method: "session.send", params } }));
    });
    expect(mock.services[0]!.request).toHaveBeenCalledWith("session.send", params);
    expect(channels[0]!.port1.postMessage).toHaveBeenCalledWith({ type: "response", id: "queued-send", result: undefined });
    expect(frame.src).toBe(source);
    expect(channels).toHaveLength(1);
  });

  it("accepts the handshake only from its exact iframe and same origin", async () => {
    render(<TuttiAgentGuiPanel {...props} />, { wrapper: TestProvider });
    await ready("https://other.invalid");
    await ready("null");
    await ready(window.location.origin, window);
    expect(channels).toHaveLength(0);
    await ready();
    expect(channels).toHaveLength(1);
    expect(channels[0]!.port1.start).toHaveBeenCalled();
  });

  it("never delivers an old response into a replacement channel with reused request IDs", async () => {
    render(<TuttiAgentGuiPanel {...props} />, { wrapper: TestProvider });
    await ready();
    const old = channels[0]!.port1;
    let resolve!: (value: string) => void;
    mock.services[0]!.request.mockReturnValueOnce(new Promise<string>((done) => { resolve = done; }));
    old.onmessage!(new MessageEvent("message", { data: { type: "request", id: "1", method: "workspace.load", params: {} } }));
    await ready();
    const replacement = channels[1]!.port1;
    expect(old.close).toHaveBeenCalled();
    await act(async () => { resolve("old workspace result"); });
    expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "response", id: "1" }));
    expect(old.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "response", id: "1" }));
  });

  it("keeps the source document and its unsent draft alive across retained tabs, blocking background writes", async () => {
    const view = render(<TuttiAgentGuiPanel {...props} />, { wrapper: TestProvider });
    const frame = await ready();
    const before = frame.src;
    const service = mock.services[0]!;
    view.rerender(<TuttiAgentGuiPanel {...props} active={false} />);
    expect(service.dispose).not.toHaveBeenCalled();
    expect(channels[0]!.port1.close).not.toHaveBeenCalled();
    channels[0]!.port1.onmessage!(new MessageEvent("message", { data: { type: "request", id: "hidden-send", method: "session.send", params: { sessionId: "session", content: "hello" } } }));
    expect(channels[0]!.port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "hidden-send", error: expect.objectContaining({ code: "inactive_host" }) }));
    expect(service.request).not.toHaveBeenCalled();
    view.rerender(<TuttiAgentGuiPanel {...props} />);
    expect(frame.src).toBe(before);
    expect(channels).toHaveLength(1);
    view.unmount();
    expect(service.dispose).toHaveBeenCalled();
    expect(channels[0]!.port1.close).toHaveBeenCalled();
  });
});
