import { z } from "zod";
import type { QueryClient } from "@tanstack/react-query";
import { LOCAL_V2_VERSION, localV2HelloSchema, localV2ServerMessageSchema, localV2SessionListSchema, localV2SnapshotSchema, type LocalV2Snapshot, type LocalV2Summary } from "@multica/core/local-conversation/v2";
import { LOCAL_V2_FOCUS_CAPABILITY, LocalV2FocusTracker } from "@multica/core/local-conversation/focus";
import { createRequestId } from "@/lib/request-id";
import { applyEvents, retainSnapshotHistory } from "./projection";
import { queueSchema, readResponse } from "./schemas";

export interface DeviceEndpoint { url: string; token: string }
export interface SessionScope { userId: string; workspaceId: string; deviceId: string }
export const aiKeys = {
  devices: (userId: string) => ["ai-devices", userId] as const,
  scope: (s: SessionScope) => ["ai-sessions", s.userId, s.workspaceId, s.deviceId] as const,
  list: (s: SessionScope) => [...aiKeys.scope(s), "list"] as const,
  snapshot: (s: SessionScope, id: string) => [...aiKeys.scope(s), "snapshot", id] as const,
};

export type SocketFactory = (url: string, headers: Record<string, string>) => WebSocket;

const REQUEST_TIMEOUT_MS = 30_000;
// Matches desktop: a send waits for thread setup, which can take up to a minute.
const COMMAND_TIMEOUT_MS = 120_000;
const DISCONNECT_NOTICE_MS = 2_500;
// A socket that dies sooner keeps backing off, so a device that accepts and
// immediately drops connections cannot cause a tight reconnect loop.
const STABLE_SOCKET_MS = 5_000;

const isLinkFailure = (error: unknown) => error instanceof TypeError || (error instanceof Error && error.message === "device_unreachable");

export class AISessionClient {
  private socket?: WebSocket;
  private connecting = false;
  private timer?: ReturnType<typeof setTimeout>;
  private handshake?: ReturnType<typeof setTimeout>;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private backoff = 500;
  private retryImmediately = true;
  private closedSockets = 0;
  private selected?: string;
  private reads = new Map<string, AbortController>();
  private readRetries = new Set<ReturnType<typeof setTimeout>>();
  private recoveryWaiters = new Set<(recovered: boolean) => void>();
  private rejected = new Set<string>();
  private refreshingQueues = new Set<string>();
  private listeners = new Set<() => void>();
  private focusSupported = false;
  private focused = new LocalV2FocusTracker((id, focused) => {
    // A daemon that cannot use it has nothing to catch up on either.
    if (!this.focusSupported) return true;
    if (this.socket?.readyState !== 1) return false;
    this.send({ version: LOCAL_V2_VERSION, type: "conversation.focus", conversation_id: id, focused });
    return true;
  });
  /** Stays true through the short reconnect window, so a brief drop shows nothing. */
  connected = false;
  readonly clientId = createRequestId();

  constructor(readonly endpoint: DeviceEndpoint, readonly scope: SessionScope, private qc: QueryClient, private socketFactory: SocketFactory, private fetcher: typeof fetch = fetch) {}

  headers() { return { Authorization: `Bearer ${this.endpoint.token}`, "X-Workspace-ID": this.scope.workspaceId, "X-Multica-Client-ID": this.clientId }; }
  url(path: string) { return `${this.endpoint.url}/devices/${encodeURIComponent(this.scope.deviceId)}/local/v2${path}`; }

  async request<T>(method: "GET" | "POST", path: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort);
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, timeoutMs);
    try {
      const response = await this.fetcher(this.url(path), { method, headers: { ...this.headers(), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      const value: unknown = await response.json();
      if (!response.ok) {
        const error = z.object({ error: z.object({ kind: z.string(), message: z.string() }) }).safeParse(value);
        throw new Error(error.success ? error.data.error.kind : `http_${response.status}`);
      }
      return readResponse(value, schema, path);
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
  }

  async list(signal?: AbortSignal): Promise<LocalV2Summary[]> {
    let after = 0;
    const items = new Map<string, LocalV2Summary>();
    while (true) {
      const page = await this.request("GET", `/sessions?after_scope_seq=${after}`, localV2SessionListSchema, undefined, signal);
      for (const summary of page.summaries) items.set(summary.conversation_id, summary);
      const cursor = Math.max(page.scope_seq, ...page.summaries.map((s) => s.summary_seq));
      if (!page.has_more) break;
      if (cursor <= after) throw new Error("invalid_response");
      after = cursor;
    }
    return [...items.values()];
  }

  async snapshot(id: string, signal?: AbortSignal) {
    const next = await this.request("GET", `/sessions/${encodeURIComponent(id)}/snapshot`, localV2SnapshotSchema, undefined, signal);
    return retainSnapshotHistory(this.qc.getQueryData<LocalV2Snapshot>(aiKeys.snapshot(this.scope, id)), next);
  }
  private async refreshQueue(id: string) {
    if (this.refreshingQueues.has(id)) return;
    this.refreshingQueues.add(id);
    let received = -1;
    try {
      const queue = await this.request("GET", `/sessions/${encodeURIComponent(id)}/queue`, queueSchema);
      received = queue.revision;
      if (!this.stopped) this.qc.setQueryData<LocalV2Snapshot>(aiKeys.snapshot(this.scope, id), (old) => old && queue.revision >= old.queue.revision ? { ...old, queue } : old);
    } catch { /* Reconnect snapshots and the queue sheet reconcile failures. */ }
    finally {
      this.refreshingQueues.delete(id);
      const current = this.qc.getQueryData<LocalV2Snapshot>(aiKeys.snapshot(this.scope, id));
      if (!this.stopped && received >= 0 && current && current.queue.revision > received) void this.refreshQueue(id);
    }
  }
  command<T>(id: string, body: Record<string, unknown>, schema: z.ZodType<T>) { return this.request("POST", `/sessions/${encodeURIComponent(id)}/commands`, schema, body, undefined, COMMAND_TIMEOUT_MS); }
  /** For commands the daemon deduplicates by request ID: a failure during the reconnect window is retried once the link recovers. */
  async submit<T>(id: string, body: Record<string, unknown>, schema: z.ZodType<T>) {
    const closedSockets = this.closedSockets;
    try { return await this.command(id, body, schema); }
    catch (error) {
      if (!isLinkFailure(error)) throw error;
      const recovered = this.reconnecting() ? await this.linkRecovery() : this.closedSockets !== closedSockets;
      if (!recovered) throw error;
      return this.command(id, body, schema);
    }
  }
  private reconnecting() { return this.connected && this.socket?.readyState !== 1; }
  private linkRecovery() { return new Promise<boolean>((resolve) => { this.recoveryWaiters.add(resolve); }); }
  private settleRecovery(recovered: boolean) { for (const resolve of this.recoveryWaiters) resolve(recovered); this.recoveryWaiters.clear(); }
  onConnection(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify() { for (const listener of this.listeners) listener(); }
  private status(value: boolean) { clearTimeout(this.noticeTimer); this.noticeTimer = undefined; this.connected = value; this.notify(); }
  subscriptionRejected(id: string) { return this.rejected.has(id); }
  retrySubscription(id: string) { if (this.rejected.delete(id)) this.notify(); void this.resync(id); }

  async connect() {
    if (this.stopped || this.socket || this.connecting) return;
    this.connecting = true;
    try {
      const hello = await this.request("GET", "/hello", localV2HelloSchema);
      if (hello.version !== LOCAL_V2_VERSION || !hello.capabilities.includes("device-link")) throw new Error("incompatible");
      if (this.stopped) return;
      this.focusSupported = hello.capabilities.includes(LOCAL_V2_FOCUS_CAPABILITY);
      const ws = this.socketFactory(this.url("/ws").replace(/^http/, "ws"), this.headers());
      let openedAt: number | undefined;
      this.socket = ws;
      this.handshake = setTimeout(() => ws.close(), 20_000);
      ws.onopen = () => {
        clearTimeout(this.handshake);
        if (this.stopped) return;
        openedAt = Date.now();
        this.rejected.clear();
        this.status(true);
        this.settleRecovery(true);
        ws.send(JSON.stringify({ version: 2, type: "subscribe_scope", after_scope_seq: 0 }));
        this.focused.reconnected();
        void this.qc.invalidateQueries({ queryKey: aiKeys.list(this.scope) });
        if (!this.selected) return;
        // The daemon answers snapshot_required when a cached position is unusable.
        const cached = this.qc.getQueryData<LocalV2Snapshot>(aiKeys.snapshot(this.scope, this.selected));
        if (cached) this.subscribe(cached); else void this.resync(this.selected);
      };
      ws.onmessage = (event) => { if (typeof event.data === "string") { try { this.receive(JSON.parse(event.data)); } catch { /* Ignore non-protocol frames. */ } } };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        clearTimeout(this.handshake);
        if (this.socket !== ws) return;
        this.socket = undefined;
        this.closedSockets++;
        this.cancelReads();
        if (openedAt !== undefined && Date.now() - openedAt >= STABLE_SOCKET_MS) { this.backoff = 500; this.retryImmediately = true; }
        this.linkLost();
      };
    } catch { this.linkLost(); }
    finally { this.connecting = false; }
  }
  private linkLost() {
    if (this.connected && !this.noticeTimer) {
      this.noticeTimer = setTimeout(() => { this.noticeTimer = undefined; this.status(false); this.settleRecovery(false); }, DISCONNECT_NOTICE_MS);
    }
    this.retry();
  }
  private retry() {
    if (this.stopped || this.timer) return;
    const delay = this.retryImmediately ? 0 : this.backoff;
    if (this.retryImmediately) this.retryImmediately = false;
    else this.backoff = Math.min(this.backoff * 2, 10_000);
    this.timer = setTimeout(() => { this.timer = undefined; void this.connect(); }, delay);
  }
  /** The session screen is on show until the returned function is called. */
  focus(id: string): () => void { return this.focused.hold(id); }
  select(id: string) {
    if (this.selected === id) return;
    if (this.selected && this.selected !== id) { this.rejected.delete(this.selected); this.send({ version: 2, type: "unsubscribe", conversation_id: this.selected }); }
    this.selected = id;
    const snapshot = this.qc.getQueryData<LocalV2Snapshot>(aiKeys.snapshot(this.scope, id));
    if (snapshot && this.connected) this.subscribe(snapshot);
  }
  private send(value: unknown) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(value)); }
  private subscribe(snapshot: LocalV2Snapshot) { this.send({ version: 2, type: "subscribe", conversation_id: snapshot.conversation.conversation_id, after_seq: snapshot.snapshot_seq, store_generation: snapshot.store_generation }); }
  private cancelReads() {
    for (const read of this.reads.values()) read.abort();
    this.reads.clear();
    for (const retry of this.readRetries) clearTimeout(retry);
    this.readRetries.clear();
  }
  private async resync(id: string, attempt = 0) {
    if (this.reads.has(id)) return;
    const read = new AbortController();
    this.reads.set(id, read);
    try {
      const snapshot = await this.snapshot(id, read.signal);
      if (this.stopped || read.signal.aborted) return;
      this.qc.setQueryData(aiKeys.snapshot(this.scope, id), snapshot);
      if (this.selected === id) this.subscribe(snapshot);
    } catch {
      // A socket change cancels reads and subscribes for itself; otherwise keep
      // trying so the open conversation does not silently lose live events.
      if (!read.signal.aborted && !this.stopped && this.selected === id) {
        const retry = setTimeout(() => { this.readRetries.delete(retry); void this.resync(id, attempt + 1); }, Math.min(500 * 2 ** attempt, 10_000));
        this.readRetries.add(retry);
      }
    } finally { if (this.reads.get(id) === read) this.reads.delete(id); }
  }
  receive(raw: unknown) {
    const result = localV2ServerMessageSchema.safeParse(raw);
    if (!result.success) return;
    const message = result.data;
    if (message.type === "scope.summaries") {
      this.qc.setQueryData<LocalV2Summary[]>(aiKeys.list(this.scope), (old) => {
        const summaries = new Map((old ?? []).map((s) => [s.conversation_id, s]));
        for (const summary of message.summaries) if ((summaries.get(summary.conversation_id)?.summary_seq ?? -1) < summary.summary_seq) summaries.set(summary.conversation_id, summary);
        return [...summaries.values()];
      });
      for (const summary of message.summaries) {
        this.qc.setQueryData<LocalV2Snapshot>(aiKeys.snapshot(this.scope, summary.conversation_id), (old) =>
          old && old.conversation.summary_seq < summary.summary_seq ? { ...old, conversation: summary } : old);
      }
    } else if (message.type === "conversation.events") {
      if (this.reads.has(message.conversation_id)) return;
      const key = aiKeys.snapshot(this.scope, message.conversation_id);
      const old = this.qc.getQueryData<LocalV2Snapshot>(key);
      const updated = old ? applyEvents(old, message.events) : null;
      if (updated) this.qc.setQueryData(key, updated); else void this.resync(message.conversation_id);
      if (message.events.some((event) => event.type === "queue.updated")) void this.refreshQueue(message.conversation_id);
    } else if (message.type === "subscription.status") {
      const id = message.conversation_id;
      if (message.status === "resubscribe" || message.status === "snapshot_required") {
        if (id) void this.resync(id);
        else void this.qc.invalidateQueries({ queryKey: aiKeys.list(this.scope) });
      } else if (message.status === "rejected") {
        if (id) { this.rejected.add(id); this.notify(); }
        // The session list has no notice of its own; a new socket retries it.
        else this.socket?.close();
      } else if (message.status === "subscribed" && id && this.rejected.delete(id)) this.notify();
    } else if (message.type === "host.request") {
      // Requests requiring desktop-only UI must fail explicitly, never hang
      // an execution or apply remote settings without the user's confirmation.
      this.send({ version: 2, type: "host.reply", request_id: message.request_id, error: { kind: "unsupported", message: "This operation requires Multica Desktop" } });
    }
  }
  close() {
    this.stopped = true; clearTimeout(this.timer); clearTimeout(this.handshake);
    this.focused.dispose();
    this.cancelReads(); this.settleRecovery(false);
    if (this.socket) { this.socket.onclose = null; this.socket.onmessage = null; this.socket.onopen = null; this.socket.onerror = null; this.socket.close(); }
    this.socket = undefined; this.status(false);
  }
}
