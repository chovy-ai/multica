import { createHash } from "node:crypto";
import { WebContentsView, type BrowserWindow } from "electron";
import type { WebPreviewCommand, WebPreviewState } from "../shared/resource-preview";

export function previewUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Invalid webpage address");
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an http or https webpage address");
  return url.href;
}

/** Remote pages have their own sandboxed WebContents, without the application preload. */
export class ResourceWebPreview {
  private entries = new Map<string, { owner: string; view: WebContentsView; error?: string }>();
  constructor(private window: BrowserWindow) { window.once("closed", () => this.dispose()); }
  private state(id: string): WebPreviewState {
    const entry = this.entries.get(id)!; const contents = entry.view.webContents;
    return { id, url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(), error: entry.error };
  }
  private publish(id: string) {
    if (!this.window.isDestroyed() && this.entries.has(id)) this.window.webContents.send("resource-preview:changed", this.state(id));
  }
  async request(owner: string, command: WebPreviewCommand): Promise<WebPreviewState | null> {
    if (!command || typeof command.id !== "string" || !/^[a-z0-9:-]{1,160}$/i.test(command.id)) throw new Error("Invalid preview tab");
    const { id, action } = command;
    if (!["show", "hide", "close", "navigate", "back", "forward", "reload"].includes(action)) throw new Error("Invalid preview action");
    let entry = this.entries.get(id);
    if (entry && entry.owner !== owner) throw new Error("Preview belongs to another workspace");
    if (action === "close") {
      if (entry) { this.window.contentView.removeChildView(entry.view); entry.view.webContents.close(); this.entries.delete(id); } return null;
    }
    if (!entry) {
      if (action === "hide") return null;
      const url = previewUrl(command.url);
      const partition = `persist:multica-preview-${createHash("sha256").update(owner).digest("hex")}`;
      const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
      entry = { owner, view }; this.entries.set(id, entry);
      view.setVisible(false); this.window.contentView.addChildView(view);
      const contents = view.webContents;
      contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      contents.session.setPermissionCheckHandler(() => false);
      const guard = (event: Electron.Event, url: string) => { try { previewUrl(url); } catch { event.preventDefault(); } };
      contents.on("will-navigate", guard); contents.on("will-redirect", guard);
      contents.setWindowOpenHandler(({ url }) => { try { void contents.loadURL(previewUrl(url)).catch(() => {}); } catch { /* Keep unsupported protocols outside the preview. */ } return { action: "deny" }; });
      const publish = () => this.publish(id);
      contents.on("did-start-loading", publish); contents.on("did-stop-loading", publish); contents.on("did-navigate", publish); contents.on("did-navigate-in-page", publish); contents.on("page-title-updated", publish);
      contents.on("did-fail-load", (_event, code, message, _url, mainFrame) => { if (mainFrame && code !== -3) { const active = this.entries.get(id); if (active) active.error = message; view.setVisible(false); this.publish(id); } });
      void contents.loadURL(url).catch(() => {});
    }
    const contents = entry.view.webContents;
    if (action === "navigate") { entry.error = undefined; void contents.loadURL(previewUrl(command.url)).catch(() => {}); }
    if (action === "back" && contents.navigationHistory.canGoBack()) { entry.error = undefined; contents.navigationHistory.goBack(); }
    if (action === "forward" && contents.navigationHistory.canGoForward()) { entry.error = undefined; contents.navigationHistory.goForward(); }
    if (action === "reload") { entry.error = undefined; contents.reload(); }
    if (action === "hide") entry.view.setVisible(false);
    if (action === "show" && command.bounds) {
      const box = command.bounds; const size = this.window.getContentBounds(); const zoom = this.window.webContents.getZoomFactor();
      if (![box.x, box.y, box.width, box.height].every((value) => Number.isFinite(value) && value >= 0)) throw new Error("Invalid preview bounds");
      const x = Math.min(size.width, Math.round(box.x * zoom)), y = Math.min(size.height, Math.round(box.y * zoom));
      const width = Math.max(0, Math.min(size.width - x, Math.round(box.width * zoom))), height = Math.max(0, Math.min(size.height - y, Math.round(box.height * zoom)));
      for (const [other, item] of this.entries) if (other !== id) item.view.setVisible(false);
      entry.view.setBounds({ x, y, width, height }); entry.view.setVisible(!entry.error && width > 0 && height > 0);
    }
    return this.state(id);
  }
  dispose() { for (const entry of this.entries.values()) { if (!this.window.isDestroyed()) this.window.contentView.removeChildView(entry.view); if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close(); } this.entries.clear(); }
}
