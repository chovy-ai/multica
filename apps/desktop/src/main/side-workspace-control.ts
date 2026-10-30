import { randomUUID } from "node:crypto";
import { sideWorkspaceSyncSchema, type LocalConversationScope, type SideWorkspaceSnapshot } from "@multica/core/local-conversation/protocol";
import { sideWorkspaceAckSchema, sideWorkspaceControlSchema, type SideWorkspaceAck, type SideWorkspaceCommand, type SideWorkspaceControlRequest } from "../shared/side-workspace";
import { SideBrowserController } from "./side-browser-controller";
import type { ResourceWebPreview } from "./resource-web-preview";

interface Options {
  currentUser(): string | null | undefined;
  /** deviceId is "local" or another device whose conversation it is. */
  snapshot(scope: LocalConversationScope, id: string, deviceId: string): Promise<SideWorkspaceSnapshot | null>;
  assertTurn(scope: LocalConversationScope, id: string, turnId: string, deviceId: string): Promise<void>;
  send(command: SideWorkspaceCommand): void;
  preview(): ResourceWebPreview;
  activity(tabId: string, conversationId: string, turnId: string, active: boolean): void;
}
export class SideWorkspaceControl {
  readonly browser: SideBrowserController;
  private endedTurns = new Set<string>();
  private pending = new Map<string, { request: SideWorkspaceControlRequest; resolve(value: SideWorkspaceAck): void; reject(error: Error): void }>();
  private receipts = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  constructor(private options: Options) { this.browser = new SideBrowserController(options.activity); }
  handle(raw: unknown, signal: AbortSignal): Promise<unknown> {
    const request = sideWorkspaceControlSchema.parse(raw);
    if (request.scope.userId !== this.options.currentUser()) return Promise.reject(new Error("Side workspace account is no longer active"));
    const key = request.requestId && JSON.stringify([request.scope, request.conversationId, request.turnId, request.requestId]);
    if (!key) return this.perform(request, signal);
    const fingerprint = JSON.stringify(request), existing = this.receipts.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(new Error("request_id belongs to a different Side action"));
      return existing.result;
    }
    const result = this.perform(request, signal); this.receipts.set(key, { fingerprint, result }); return result;
  }
  private async perform(request: SideWorkspaceControlRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    const { scope, conversationId, turnId, tabId, op } = request;
    const device = request.deviceId ?? "local";
    if (!turnId) throw new Error("Side control requires a turn ID");
    const turnKey = JSON.stringify([scope, conversationId, turnId]);
    if (op === "release") {
      this.endedTurns.add(turnKey);
      this.browser.release(conversationId, turnId);
      return this.command(request, signal);
    }
    if (this.endedTurns.has(turnKey)) throw new Error("The controlling Side execution has ended");
    await this.options.assertTurn(scope, conversationId, turnId, device);
    const snapshot = await this.options.snapshot(scope, conversationId, device);
    if (!snapshot) throw new Error("desktop_not_connected: Side workspace has not synced");
    const tab = snapshot.tabs.find((tab) => tab.id === tabId);
    if (op !== "open" && !tab) throw new Error("not_in_current_side: This tab is not open in this conversation");
    if (op === "close" && (tab?.kind !== "web" || tab.openedBy !== "agent" || tab.turnId !== turnId)) throw new Error("User tabs cannot be closed by the assistant");
    if (op === "open" && !request.tab) throw new Error("Specify a tab to open");
    if (op !== "browser") return this.command(request, signal);
    if (tab?.kind !== "web" || !request.action) throw new Error("Browser control requires an open webpage tab and an action");
    const owner = JSON.stringify([scope.userId, scope.workspaceId]);
    await this.command({ ...request, op: "select", action: undefined }, signal);
    // Recheck after asynchronous UI changes, before acquiring a real WebContents.
    const latest = await this.options.snapshot(scope, conversationId, device);
    if (!latest?.tabs.some((entry) => entry.id === tab.id && entry.kind === "web")) throw new Error("not_in_current_side: The tab has closed");
    if (scope.userId !== this.options.currentUser()) throw new Error("Side workspace account changed");
    if (this.endedTurns.has(turnKey)) throw new Error("The controlling Side execution has ended");
    const contents = await this.options.preview().ensure(owner, tab.id, tab.url);
    await this.options.assertTurn(scope, conversationId, turnId, device);
    if (this.endedTurns.has(turnKey)) throw new Error("The controlling Side execution has ended");
    return this.browser.run(tab.id, contents, conversationId, turnId, request.action, signal);
  }
  private command(request: SideWorkspaceControlRequest, signal: AbortSignal): Promise<SideWorkspaceAck> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: SideWorkspaceAck) => {
        clearTimeout(timer); signal.removeEventListener("abort", abort); this.pending.delete(id);
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(new Error("Side command cancelled; inspect live tabs before another request"));
      const timer = setTimeout(() => finish(new Error("Side renderer acknowledgement timed out; action status is unknown")), 3000);
      this.pending.set(id, { request, resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try { this.options.send({ id, request }); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  ack(raw: unknown) {
    const reply = sideWorkspaceAckSchema.parse(raw), pending = this.pending.get(reply.id);
    if (!pending) return;
    if (pending.request.scope.userId !== this.options.currentUser()) { pending.reject(new Error("Side account changed")); return; }
    if (reply.error) { pending.reject(new Error(reply.error)); return; }
    const snapshot = sideWorkspaceSyncSchema.parse(reply.snapshot);
    if (snapshot.conversationId !== pending.request.conversationId) { pending.reject(new Error("Side acknowledgement belongs to another conversation")); return; }
    pending.resolve({ ...reply, snapshot });
  }
  reconcile(snapshot: SideWorkspaceSnapshot) { this.browser.reconcile(snapshot.conversationId, new Set(snapshot.tabs.filter((tab) => tab.kind === "web").map((tab) => tab.id))); }
  /** Closes browser tabs the conversation's stored layout no longer has. */
  async reconcileFrom(scope: LocalConversationScope, conversationId: string, deviceId: string) {
    const snapshot = await this.options.snapshot(scope, conversationId, deviceId);
    if (snapshot) this.reconcile(snapshot);
  }
  dispose() {
    this.browser.dispose();
    for (const pending of this.pending.values()) pending.reject(new Error("Side workspace disconnected"));
    this.receipts.clear(); this.endedTurns.clear();
  }
}
