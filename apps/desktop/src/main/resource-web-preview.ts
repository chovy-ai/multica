import { createHash } from "node:crypto";
import { WebContentsView, type BrowserWindow } from "electron";
import type { WebPreviewCommand, WebPreviewState, WebPreviewTarget, WebPreviewPhase } from "../shared/resource-preview";
import { ResourceChromeProfileImport } from "./resource-chrome-profile-import";
import type { RemotePreviewNetwork } from "./remote-preview-network";

export function previewUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Invalid webpage address");
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an http or https webpage address");
  return url.href;
}

/** Remote pages have their own sandboxed WebContents, without the application preload. */
export class ResourceWebPreview {
  private entries = new Map<string, { owner: string; view: WebContentsView; url: string; target?: WebPreviewTarget; error?: string; phase?: WebPreviewPhase; ready?: Promise<void>; release?: () => void; visible?: boolean }>();
  readonly chromeProfiles: ResourceChromeProfileImport;
  constructor(private window: BrowserWindow, importOptions: ConstructorParameters<typeof ResourceChromeProfileImport>[1], private network?: RemotePreviewNetwork) {
    window.once("closed", () => this.dispose());
    this.chromeProfiles = new ResourceChromeProfileImport((owner, id) => {
      const entry = this.entries.get(id);
      if (!entry || entry.owner !== owner || entry.view.webContents.isDestroyed()) throw new Error("Invalid preview target");
      const session = entry.view.webContents.session;
      return {
        cookies: session.cookies,
        isAvailable: () => this.entries.get(id) === entry && !entry.view.webContents.isDestroyed(),
        reload: () => {
          for (const [tabId, item] of this.entries) {
            const contents = item.view.webContents;
            if (item.owner === owner && !contents.isDestroyed() && contents.session === session) {
              item.error = undefined;
              contents.reload();
              this.publish(tabId);
            }
          }
        },
      };
    }, importOptions);
  }
  private state(id: string): WebPreviewState {
    const entry = this.entries.get(id)!; const contents = entry.view.webContents;
    return { id, url: contents.getURL() || entry.url, title: contents.getTitle(), loading: contents.isLoading() || Boolean(entry.target && !entry.release && !entry.error), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(), error: entry.error, phase: entry.phase };
  }
  private publish(id: string) {
    if (!this.window.isDestroyed() && this.entries.has(id)) this.window.webContents.send("resource-preview:changed", this.state(id));
  }
  async request(owner: string, command: WebPreviewCommand): Promise<WebPreviewState | null> {
    if (!command || typeof command.id !== "string" || !/^[a-z0-9:-]{1,160}$/i.test(command.id)) throw new Error("Invalid preview tab");
    const { id, action } = command;
    if (!["show", "hide", "close", "navigate", "back", "forward", "reload"].includes(action)) throw new Error("Invalid preview action");
    let entry = this.entries.get(id);
    let initialized = false;
    if (entry && entry.owner !== owner) throw new Error("Preview belongs to another workspace");
    if (entry && !["hide", "close"].includes(action) && (entry.target?.deviceId !== command.target?.deviceId || entry.target?.conversationId !== command.target?.conversationId)) throw new Error("Preview belongs to another device or conversation");
    if (action === "close") {
      this.chromeProfiles.closeTab(owner, id);
      if (entry) { entry.release?.(); this.window.contentView.removeChildView(entry.view); entry.view.webContents.close(); this.entries.delete(id); } return null;
    }
    if (!entry) {
      if (action === "hide") return null;
      const url = previewUrl(command.url);
      if (command.target && !this.network) throw new Error("preview_unsupported: Remote service preview is unavailable");
      const partitionOwner = command.target ? this.network!.partition(owner, command.target) : owner;
      const partition = `persist:multica-preview-${createHash("sha256").update(partitionOwner).digest("hex")}`;
      const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
      entry = { owner, view, url, target: command.target }; this.entries.set(id, entry);
      view.setVisible(false); this.window.contentView.addChildView(view);
      const contents = view.webContents;
      if (entry.target) contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      contents.session.setPermissionCheckHandler(() => false);
      const guard = (event: Electron.Event, url: string) => { try { previewUrl(url); } catch { event.preventDefault(); } };
      contents.on("will-navigate", guard); contents.on("will-redirect", guard);
      contents.setWindowOpenHandler(({ url }) => { try { void contents.loadURL(previewUrl(url)).catch(() => {}); } catch { /* Keep unsupported protocols outside the preview. */ } return { action: "deny" }; });
      const publish = () => { const current = this.entries.get(id); if (current && !contents.isLoading() && !current.error) current.phase = "ready"; this.publish(id); };
      contents.on("did-start-loading", publish); contents.on("did-stop-loading", publish); contents.on("did-navigate-in-page", publish); contents.on("page-title-updated", publish);
      contents.on("did-navigate", (_event, _url, status) => {
        const current = this.entries.get(id);
        const failure = current?.target && status === 502 ? this.network?.error(owner, current.target) : undefined;
        if (current && failure) { current.error = failure; current.phase = "disconnected"; view.setVisible(false); }
        publish();
      });
      contents.on("did-fail-load", (_event, code, message, _url, mainFrame) => { if (mainFrame && code !== -3) { const active = this.entries.get(id); if (active) { active.error = active.target ? this.network?.error(owner, active.target) || message : message; active.phase = "disconnected"; } view.setVisible(false); this.publish(id); } });
      if (!entry.target) { initialized = true; void contents.loadURL(url).catch(() => {}); }
    }
    if (action === "show" || action === "hide") entry.visible = action === "show";
    if (entry.target && !entry.release && !["hide", "close"].includes(action)) {
      const pending = entry;
      initialized = !pending.ready;
      pending.ready ??= this.network!.acquire(owner, pending.target!, command.url ?? pending.url, pending.view.webContents.session, (phase) => { if (this.entries.get(id) === pending) { pending.phase = phase; this.publish(id); } }).then((release) => {
        if (this.entries.get(id) !== pending) { release(); throw new Error("Preview closed"); }
        pending.release = release; pending.error = undefined;
        void pending.view.webContents.loadURL(previewUrl(command.url ?? pending.url)).catch(() => {});
      });
      try { await pending.ready; if (this.entries.get(id) !== pending) return null; }
      catch (error) { if (this.entries.get(id) !== pending) return null; pending.ready = undefined; pending.error = error instanceof Error ? error.message : "Service preview failed"; pending.phase = "disconnected"; this.publish(id); return this.state(id); }
    }
    const contents = entry.view.webContents;
    if (action === "navigate" && !initialized) { entry.error = undefined; void contents.loadURL(previewUrl(command.url)).catch(() => {}); }
    if (action === "back" && contents.navigationHistory.canGoBack()) { entry.error = undefined; contents.navigationHistory.goBack(); }
    if (action === "forward" && contents.navigationHistory.canGoForward()) { entry.error = undefined; contents.navigationHistory.goForward(); }
    if (action === "reload" && !initialized) { entry.error = undefined; contents.reload(); }
    if (action === "hide") entry.view.setVisible(false);
    if (action === "show" && entry.visible && command.bounds) {
      const box = command.bounds; const size = this.window.getContentBounds(); const zoom = this.window.webContents.getZoomFactor();
      if (![box.x, box.y, box.width, box.height].every((value) => Number.isFinite(value) && value >= 0)) throw new Error("Invalid preview bounds");
      const x = Math.min(size.width, Math.round(box.x * zoom)), y = Math.min(size.height, Math.round(box.y * zoom));
      const width = Math.max(0, Math.min(size.width - x, Math.round(box.width * zoom))), height = Math.max(0, Math.min(size.height - y, Math.round(box.height * zoom)));
      for (const [other, item] of this.entries) if (other !== id) item.view.setVisible(false);
      entry.view.setBounds({ x, y, width, height }); entry.view.setVisible(!entry.error && width > 0 && height > 0);
    }
    return this.state(id);
  }
  async ensure(owner: string, id: string, url: string, target?: WebPreviewTarget) {
    const state = await this.request(owner, { id, action: "show", url, target });
    if (state?.error) throw new Error(state.error);
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner || entry.view.webContents.isDestroyed()) throw new Error("Invalid preview target");
    return entry.view.webContents;
  }
  dispose() { this.chromeProfiles.dispose(); for (const entry of this.entries.values()) { entry.release?.(); if (!this.window.isDestroyed()) this.window.contentView.removeChildView(entry.view); if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close(); } this.entries.clear(); this.network?.dispose(); }
}
