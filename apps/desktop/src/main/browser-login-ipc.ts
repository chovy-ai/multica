import { app, ipcMain, type BrowserWindow } from "electron";
import { DesktopBrowserLogin } from "./browser-login";
import { openExternalSafely } from "./external-url";

export function registerDesktopProtocol(development: boolean): void {
  // Dev's generic Electron bundle cannot identify a worktree on macOS.
  if (!development) app.setAsDefaultProtocolClient("multica");
}

export function setupBrowserLogin(options: {
  development: boolean;
  getWindow: () => BrowserWindow | null;
  getAppUrl: () => string;
  onToken: (token: string) => void;
}): void {
  const login = new DesktopBrowserLogin({ openBrowser: openExternalSafely, onToken: options.onToken });
  ipcMain.handle("auth:browser-login", (event) => {
    const window = options.getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Browser login requires the active main window");
    }
    const appUrl = options.getAppUrl();
    if (options.development) return login.start(appUrl);
    return openExternalSafely(new URL("/login?platform=desktop", appUrl).href);
  });
  app.on("will-quit", () => login.dispose());
}
