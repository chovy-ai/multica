import { resolve } from "node:path";
import { clipboard, ipcMain, shell, type BrowserWindow } from "electron";
import { z } from "zod";
import { localResourceTarget } from "@multica/tutti-agent-gui-host/message-resource-links";
import type { LocalConversationClient } from "@multica/core/local-conversation/protocol";
import { showLocalFileContextMenu } from "./context-menu";

const scopeSchema = z.object({ userId: z.string().min(1), workspaceId: z.string().min(1) });
const inputSchema = z.object({
  sessionId: z.string().min(1), url: z.string().min(1).max(4096),
  hasSelection: z.boolean(),
});

export function setupLocalFileContextMenu(options: {
  getWindow(): BrowserWindow | null;
  currentUser(): string | null | undefined;
  request: LocalConversationClient["request"];
}): void {
  ipcMain.handle("local-file:context-menu", async (event, rawScope: unknown, rawInput: unknown) => {
    const scope = scopeSchema.parse(rawScope);
    const input = inputSchema.parse(rawInput);
    const assertCurrent = () => {
      const window = options.getWindow();
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("File actions require the active main window");
      if (scope.userId !== options.currentUser()) throw new Error("This account is no longer active");
      return window;
    };
    assertCurrent();
    const target = localResourceTarget(input.url);
    if (!target) throw new Error("Use a local file path");
    const source = await options.request(scope, "read", { id: input.sessionId });
    // Metadata validation keeps large installers usable without granting preview content.
    const location = await options.request(scope, "previewLocate", { id: input.sessionId, path: resolve(source.cwd, target.path) });
    const window = assertCurrent();
    showLocalFileContextMenu(window.webContents, input, {
      copyPath: async () => { assertCurrent(); await clipboard.writeText(location.path); },
      reveal: async () => {
        assertCurrent();
        await options.request(scope, "previewLocate", { id: input.sessionId, path: location.path });
        assertCurrent(); shell.showItemInFolder(location.path);
      },
    });
  });
}
