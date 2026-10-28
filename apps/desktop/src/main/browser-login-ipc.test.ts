// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const mocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn(), register: vi.fn(), openBrowser: vi.fn(), start: vi.fn(), dispose: vi.fn() }));
vi.mock("electron", () => ({ app: { on: mocks.on, setAsDefaultProtocolClient: mocks.register }, ipcMain: { handle: mocks.handle } }));
vi.mock("./external-url", () => ({ openExternalSafely: mocks.openBrowser }));
vi.mock("./browser-login", () => ({ DesktopBrowserLogin: class { start = mocks.start; dispose = mocks.dispose; } }));
import { registerDesktopProtocol, setupBrowserLogin } from "./browser-login-ipc";

beforeEach(() => vi.clearAllMocks());
describe("browser login IPC", () => {
  it("never registers generic dev Electron as the global protocol handler", () => {
    registerDesktopProtocol(true);
    expect(mocks.register).not.toHaveBeenCalled();
    registerDesktopProtocol(false);
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith("multica");
  });

  it("accepts only the active main frame and obtains the web origin from main", () => {
    const webContents = { mainFrame: {} };
    const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
    setupBrowserLogin({ development: true, getWindow: () => window, getAppUrl: () => "https://multica.ai", onToken: vi.fn() });
    const handler = mocks.handle.mock.calls[0][1];
    expect(() => handler({ sender: {}, senderFrame: webContents.mainFrame })).toThrow("active main window");
    expect(() => handler({ sender: webContents, senderFrame: {} })).toThrow("active main window");
    handler({ sender: webContents, senderFrame: webContents.mainFrame }, "https://untrusted.example");
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith("https://multica.ai");
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    mocks.on.mock.calls.find(([name]) => name === "will-quit")![1]();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("preserves packaged Desktop's existing browser deep-link flow", () => {
    const webContents = { mainFrame: {} };
    const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
    setupBrowserLogin({ development: false, getWindow: () => window, getAppUrl: () => "https://multica.ai", onToken: vi.fn() });
    mocks.handle.mock.calls[0][1]({ sender: webContents, senderFrame: webContents.mainFrame });
    expect(mocks.openBrowser).toHaveBeenCalledExactlyOnceWith("https://multica.ai/login?platform=desktop");
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
