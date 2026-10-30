// @vitest-environment node
import type { BrowserWindow } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChromeCookieSource } from "./resource-chrome-profile-import";
import { ResourceWebPreview } from "./resource-web-preview";
import type { RemotePreviewNetwork } from "./remote-preview-network";

const fake = vi.hoisted(() => {
  function session() { return { cookies: { set: vi.fn(async () => {}), flushStore: vi.fn(async () => {}) }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }; }
  const sessions = new Map<string, ReturnType<typeof session>>();
  const views: Array<{ contents: { session: ReturnType<typeof session>; reload: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; }; partition: string }> = [];
  return { session, sessions, views };
});
vi.mock("electron", () => ({
  WebContentsView: class {
    webContents;
    constructor({ webPreferences }: { webPreferences: { partition: string } }) {
      const partition = webPreferences.partition;
      if (!fake.sessions.has(partition)) fake.sessions.set(partition, fake.session());
      let url = "", destroyed = false;
      this.webContents = {
        session: fake.sessions.get(partition)!,
        on: vi.fn(), setWindowOpenHandler: vi.fn(), reload: vi.fn(),
        setWebRTCIPHandlingPolicy: vi.fn(),
        getURL: () => url, getTitle: () => "Fixture", isLoading: () => false,
        isDestroyed: () => destroyed, close: () => { destroyed = true; },
        loadURL: vi.fn(async (value: string) => { url = value; }),
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      };
      fake.views.push({ contents: this.webContents, partition });
    }
    setVisible() {}
    setBounds() {}
  },
}));
beforeEach(() => { fake.sessions.clear(); fake.views.length = 0; });
function setup(network?: RemotePreviewNetwork) {
  const window = { once: vi.fn(), isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, webContents: { send: vi.fn() } };
  const profileId = "chrome-fixture" as Parameters<ChromeCookieSource["prepareChromeCookieImport"]>[0];
  const source: ChromeCookieSource = {
    discoverChromeCookieProfiles: vi.fn(async () => ({ status: "available" as const, profiles: [{ id: profileId, name: "Fixture", source: "chrome" as const }] })),
    prepareChromeCookieImport: vi.fn(async () => ({ status: "ready" as const, skipped: 0, cookies: [{ url: "https://example.test/", name: "login", value: "test-only-cookie" }] })),
  };
  return { preview: new ResourceWebPreview(window as unknown as BrowserWindow, { platform: "darwin", createSource: () => source }, network), source, profileId };
}

it("writes and refreshes every tab in the target session, without touching another user or workspace", async () => {
  const { preview, profileId } = setup();
  for (const [owner, id] of [["user-one:workspace-one", "one"], ["user-one:workspace-one", "two"], ["user-one:workspace-two", "three"], ["user-two:workspace-one", "four"]]) {
    await preview.request(owner!, { id: id!, action: "show", url: "https://example.test" });
  }
  expect(fake.views[0]!.partition).toBe(fake.views[1]!.partition);
  expect(await preview.chromeProfiles.import("user-one:workspace-one", { id: "one", profileId, requestId: "receipt" })).toEqual({ status: "success", imported: 1, failed: 0, skipped: 0 });
  expect(fake.views[0]!.contents.session.cookies.set).toHaveBeenCalledOnce();
  expect(fake.views[0]!.contents.reload).toHaveBeenCalledOnce();
  expect(fake.views[1]!.contents.reload).toHaveBeenCalledOnce();
  for (const view of fake.views.slice(2)) {
    expect(view.contents.session.cookies.set).not.toHaveBeenCalled();
    expect(view.contents.reload).not.toHaveBeenCalled();
  }
  preview.dispose();
});

it("waits for the remote route, loads once across concurrent shows, and releases only on close", async () => {
  let finish!: (release: () => void) => void;
  const release = vi.fn(), acquire = vi.fn(() => new Promise<() => void>((resolve) => { finish = resolve; }));
  const network = { acquire, partition: (owner: string, target: unknown) => JSON.stringify([owner, target]), dispose: vi.fn() };
  const { preview } = setup(network as unknown as RemotePreviewNetwork);
  const command = { id: "remote", action: "show" as const, url: "http://localhost:3000/", target: { deviceId: "peer", conversationId: "conversation" } };
  const first = preview.request("owner", command), second = preview.request("owner", command);
  expect(fake.views[0]!.contents.loadURL).not.toHaveBeenCalled();
  expect(acquire).toHaveBeenCalledOnce(); finish(release); await Promise.all([first, second]);
  expect(fake.views[0]!.contents.loadURL).toHaveBeenCalledExactlyOnceWith(command.url);
  await preview.request("owner", { id: command.id, action: "hide" });
  expect(release).not.toHaveBeenCalled();
  await expect(preview.request("owner", { ...command, target: { ...command.target, deviceId: "another" } })).rejects.toThrow("another device");
  await preview.request("owner", { id: command.id, action: "close" });
  expect(release).toHaveBeenCalledOnce(); preview.dispose();
});

it("does not navigate before a failed remote route and releases a route completed after closure", async () => {
  const acquire = vi.fn().mockRejectedValueOnce(new Error("service_denied: Port is not shared"));
  const network = { acquire, partition: () => "remote", dispose: vi.fn() };
  const { preview } = setup(network as unknown as RemotePreviewNetwork);
  const command = { id: "remote", action: "show" as const, url: "http://localhost:3000/", target: { deviceId: "peer", conversationId: "conversation" } };
  expect((await preview.request("owner", command))?.error).toContain("service_denied");
  expect(fake.views[0]!.contents.loadURL).not.toHaveBeenCalled();
  let finish!: (release: () => void) => void; const release = vi.fn();
  acquire.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const pending = preview.request("owner", { ...command, action: "reload" });
  await preview.request("owner", { id: command.id, action: "close" }); finish(release);
  expect(await pending).toBeNull(); expect(release).toHaveBeenCalledOnce();
  expect(fake.views[0]!.contents.loadURL).not.toHaveBeenCalled(); preview.dispose();
});

it("shows the actionable remote connection failure when the HTTP proxy returns a gateway error", async () => {
  const network = { acquire: async () => () => {}, partition: () => "remote", error: () => "target_unreachable: Service is not running", dispose: vi.fn() };
  const { preview } = setup(network as unknown as RemotePreviewNetwork);
  const command = { id: "remote", action: "show" as const, url: "http://localhost:3000/", target: { deviceId: "peer", conversationId: "conversation" } };
  await preview.request("owner", command);
  const navigate = fake.views[0]!.contents.on.mock.calls.find(([event]) => event === "did-navigate")![1];
  navigate({}, command.url, 502);
  expect((await preview.request("owner", { id: command.id, action: "hide" }))?.error).toContain("target_unreachable"); preview.dispose();
});

it("refuses an import into an absent, foreign or closed preview before reading credentials", async () => {
  const { preview, source, profileId } = setup();
  const input = { id: "target", profileId, requestId: "receipt" };
  expect((await preview.chromeProfiles.import("owner", input)).code).toBe("invalid-target");
  await preview.request("owner", { id: "target", action: "show", url: "https://example.test" });
  expect((await preview.chromeProfiles.import("other", input)).code).toBe("invalid-target");
  await preview.request("owner", { id: "target", action: "close" });
  expect((await preview.chromeProfiles.import("owner", input)).code).toBe("invalid-target");
  expect(source.prepareChromeCookieImport).not.toHaveBeenCalled();
  preview.dispose();
});
