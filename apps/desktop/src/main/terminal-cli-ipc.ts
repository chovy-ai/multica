import { ipcMain, type BrowserWindow } from "electron";
import { homedir, userInfo } from "node:os";
import { bundledCliSource } from "./bundled-cli";
import { TerminalCliInstaller } from "./terminal-cli";
import { desktopRuntimeRegistry } from "./desktop-runtime-instance";

export function setupTerminalCli(getWindow: () => BrowserWindow | null): void {
  const installer = new TerminalCliInstaller({ home: homedir(), source: bundledCliSource(), commandTarget: desktopRuntimeRegistry().cliLink, platform: process.platform, env: { ...process.env, SHELL: process.env.SHELL || userInfo().shell || undefined } });
  for (const action of ["status", "install", "uninstall"] as const) {
    ipcMain.handle(`terminal-cli:${action}`, async (event) => {
      const window = getWindow();
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) {
        throw new Error("Terminal CLI installation requires the active main window");
      }
      if (action !== "status") await desktopRuntimeRegistry().assertOwner();
      return installer[action]();
    });
  }
}
