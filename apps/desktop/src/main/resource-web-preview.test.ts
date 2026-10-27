// @vitest-environment node
import type { BrowserWindow } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChromeCookieSource } from "./resource-chrome-profile-import";
import { ResourceWebPreview } from "./resource-web-preview";

const fake = vi.hoisted(() => {
  function session() { return { cookies: { set: vi.fn(async () => {}), flushStore: vi.fn(async () => {}) }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }; }
  const sessions = new Map<string, ReturnType<typeof session>>();
  const views: Array<{ contents: { session: ReturnType<typeof session>; reload: ReturnType<typeof vi.fn>; }; partition: string }> = [];
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
function setup() {
  const window = { once: vi.fn(), isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, webContents: { send: vi.fn() } };
  const profileId = "chrome-fixture" as Parameters<ChromeCookieSource["prepareChromeCookieImport"]>[0];
  const source: ChromeCookieSource = {
    discoverChromeCookieProfiles: vi.fn(async () => ({ status: "available" as const, profiles: [{ id: profileId, name: "Fixture", source: "chrome" as const }] })),
    prepareChromeCookieImport: vi.fn(async () => ({ status: "ready" as const, skipped: 0, cookies: [{ url: "https://example.test/", name: "login", value: "test-only-cookie" }] })),
  };
  return { preview: new ResourceWebPreview(window as unknown as BrowserWindow, { platform: "darwin", createSource: () => source }), source, profileId };
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
