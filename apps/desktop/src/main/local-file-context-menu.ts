import { createWriteStream } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { z } from "zod";
import { localResourceTarget } from "@multica/tutti-agent-gui-host/message-resource-links";
import { showLocalFileContextMenu } from "./context-menu";

const scopeSchema = z.object({ userId: z.string().min(1), workspaceId: z.string().min(1) });
const inputSchema = z.object({
  sessionId: z.string().min(1), url: z.string().min(1).max(4096),
  hasSelection: z.boolean(),
});

export function setupLocalFileContextMenu(options: {
  getWindow(): BrowserWindow | null;
  currentUser(): string | null | undefined;
  /** A GET to the local v2 API of this device ("local") or another one. */
  request(scope: z.infer<typeof scopeSchema>, path: string, deviceId: string): Promise<unknown>;
  /** Streams a file route of a device's local v2 API. */
  download(scope: z.infer<typeof scopeSchema>, path: string, deviceId: string): Promise<Response>;
}): void {
  const locate = async (scope: z.infer<typeof scopeSchema>, id: string, path: string, deviceId: string) =>
    z.object({ path: z.string(), root: z.string() }).parse(await options.request(scope, `/preview/locate?${new URLSearchParams({ conversation_id: id, path })}`, deviceId));
  ipcMain.handle("local-file:context-menu", async (event, rawScope: unknown, rawInput: unknown, rawDevice: unknown) => {
    const scope = scopeSchema.parse(rawScope);
    const input = inputSchema.parse(rawInput);
    const deviceId = rawDevice === undefined ? "local" : z.string().min(1).max(200).parse(rawDevice);
    const assertCurrent = () => {
      const window = options.getWindow();
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("File actions require the active main window");
      if (scope.userId !== options.currentUser()) throw new Error("This account is no longer active");
      return window;
    };
    assertCurrent();
    const target = localResourceTarget(input.url);
    if (!target) throw new Error("Use a local file path");
    const snapshot = z.object({ conversation: z.object({ cwd: z.string() }) }).parse(await options.request(scope, `/sessions/${encodeURIComponent(input.sessionId)}/snapshot`, deviceId));
    // Metadata validation keeps large installers usable without granting preview content.
    const location = await locate(scope, input.sessionId, resolve(snapshot.conversation.cwd, target.path), deviceId);
    const window = assertCurrent();
    const copyPath = async () => { assertCurrent(); await clipboard.writeText(location.path); };
    if (deviceId !== "local") {
      // The file is on another device: it can only be copied here.
      showLocalFileContextMenu(window.webContents, input, { copyPath, saveToThisDevice: async () => {
        const result = await dialog.showSaveDialog(assertCurrent(), { defaultPath: join(app.getPath("downloads"), basename(location.path)) });
        if (result.canceled || !result.filePath) return;
        const response = await options.download(scope, `/preview/content?${new URLSearchParams({ conversation_id: input.sessionId, root: location.root, path: location.path })}`, deviceId);
        if (!response.ok || !response.body) throw new Error(`Could not read the file from the other device (HTTP ${response.status})`);
        await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(result.filePath));
      } });
      return;
    }
    showLocalFileContextMenu(window.webContents, input, {
      copyPath,
      reveal: async () => {
        assertCurrent();
        await locate(scope, input.sessionId, location.path, deviceId);
        assertCurrent(); shell.showItemInFolder(location.path);
      },
    });
  });
}
