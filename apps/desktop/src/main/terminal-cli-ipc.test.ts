// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ handle: vi.fn(), construct: vi.fn(), status: vi.fn(), install: vi.fn(), uninstall: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock("./desktop-runtime-instance", () => ({ desktopRuntimeRegistry: () => ({ cliLink: "/test-owned/shared-runtime/cli", assertOwner: async () => ({}) }) }));
vi.mock("./bundled-cli", () => ({ bundledCliSource: () => ({ kind: "development", appPath: "/test-owned/dev-desktop", cliPath: "/test-owned/dev-desktop/resources/bin/multica" }) }));
vi.mock("./terminal-cli", () => ({ TerminalCliInstaller: class {
  constructor(options: unknown) { mocks.construct(options); }
  status = mocks.status;
  install = mocks.install;
  uninstall = mocks.uninstall;
} }));
import { setupTerminalCli } from "./terminal-cli-ipc";
import type { BrowserWindow } from "electron";

describe("terminal CLI IPC", () => {
  it("accepts only the active window's main frame, with no caller-selected paths", async () => {
    const mainFrame = {};
    const webContents = { mainFrame };
    const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
    setupTerminalCli(() => window);
    expect(mocks.construct).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: "development", appPath: "/test-owned/dev-desktop", cliPath: "/test-owned/dev-desktop/resources/bin/multica" } }));
    for (const action of ["status", "install", "uninstall"] as const) {
      const handler = mocks.handle.mock.calls.find(([name]) => name === `terminal-cli:${action}`)![1];
      await expect(handler({ sender: {}, senderFrame: mainFrame })).rejects.toThrow("active main window");
      await expect(handler({ sender: webContents, senderFrame: {} })).rejects.toThrow("active main window");
      await handler({ sender: webContents, senderFrame: mainFrame }, "/untrusted/path");
      expect(mocks[action]).toHaveBeenCalledExactlyOnceWith();
    }
  });
});
