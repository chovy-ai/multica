import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import type { LocalConversationMethod, LocalConversationMethods, LocalConversationScope } from "@multica/core/local-conversation/protocol";
import {
  eventNotificationSchema, helloSchema, hostRequestNotificationSchema, LOCAL_HOST_API_VERSION, resyncNotificationSchema,
  sessionResultSchema, sidecarStatusNotificationSchema, subscribeResultSchema, type LocalHostHello,
} from "@multica/core/local-conversation/wire";
import { appError, JsonRpcPeer, RpcError, type MessageTransport } from "../local-host/json-rpc";
import type { LocalHostAvailability } from "../shared/local-host-availability";
import { healthPortForProfile, profileDir } from "./daemon-profile";
import { readDaemonPortRecord } from "./daemon-port";

export interface LocalHostProxyOptions {
  apiUrl: string;
  profile: string;
  /** Desktop's former in-process data, migrated once by the sidecar. */
  legacyDataDir: string;
  /** Provider discovery environment (PATH, HOME, CODEX_HOME, proxies...). */
  providerEnv(): Record<string, string>;
  notify(scope: LocalConversationScope, sessionId: string): void;
  /** The view of every open conversation is stale. */
  resync(): void;
  availability(value: LocalHostAvailability): void;
  hostRequest(kind: string, payload: unknown): Promise<unknown>;
  timing(record: unknown): void;
  /** Where the daemon listens; defaults to the profile's published port and token. */
  endpoint?: () => Promise<{ base: string; token: string }>;
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

function wsTransport(socket: WebSocket): MessageTransport {
  return {
    send: (text) => socket.send(text),
    onMessage: (listener) => socket.on("message", (data, binary) => { if (!binary) listener(data.toString()); }),
    onClose: (listener) => socket.once("close", listener),
  };
}

function code(error: unknown): string | undefined {
  const data = error instanceof RpcError ? error.data : undefined;
  return data && typeof data === "object" && "code" in data && typeof data.code === "string" ? data.code : undefined;
}

/**
 * Desktop's link to the daemon-hosted conversation service: a JSON-RPC
 * WebSocket for control and events, plain HTTP for file content. The token
 * stays in the main process; the renderer only sees IPC.
 */
export class LocalHostProxy {
  private peer?: JsonRpcPeer;
  private socket?: WebSocket;
  private connecting?: Promise<JsonRpcPeer>;
  private endpoint?: { base: string; token: string };
  private userId: string | null = null;
  private cursor = "";
  private backoff = RECONNECT_MIN_MS;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private options: LocalHostProxyOptions) {}

  private apiScope(scope: LocalConversationScope) {
    return { apiUrl: this.options.apiUrl, userId: scope.userId, workspaceId: scope.workspaceId };
  }

  private async resolveEndpoint(): Promise<{ base: string; token: string }> {
    if (this.options.endpoint) return this.options.endpoint();
    const record = await readDaemonPortRecord(this.options.profile);
    const port = record?.port ?? healthPortForProfile(this.options.profile);
    let token: string;
    try { token = (await readFile(join(profileDir(this.options.profile), "local-api.token"), "utf8")).trim(); }
    catch { throw appError("daemon_offline", "Start the local daemon to use local conversations"); }
    return { base: `127.0.0.1:${port}`, token };
  }

  /** Version and capability probe; re-reads the token once when it rotated. */
  async hello(): Promise<LocalHostHello> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.endpoint = attempt === 0 && this.endpoint ? this.endpoint : await this.resolveEndpoint();
      let response: Response;
      try { response = await fetch(`http://${this.endpoint.base}/local/v1/hello`, { headers: { Authorization: `Bearer ${this.endpoint.token}` }, signal: AbortSignal.timeout(5000) }); }
      catch { throw appError("daemon_offline", "Start the local daemon to use local conversations"); }
      if (response.status === 403 && attempt === 0) { this.endpoint = undefined; continue; }
      if (!response.ok) throw appError("daemon_offline", `The local daemon refused the connection (HTTP ${response.status})`);
      const hello = helloSchema.safeParse(await response.json());
      if (!hello.success || hello.data.apiVersion !== LOCAL_HOST_API_VERSION) throw appError("incompatible", "Update Multica so Desktop and the local daemon match");
      return hello.data;
    }
    throw appError("daemon_offline", "The local daemon refused the connection");
  }

  setUser(userId: string | null): void {
    if (userId === this.userId) return;
    this.userId = userId;
    if (!userId) { this.disconnect(); return; }
    if (this.peer) void this.startSession(this.peer).catch(() => this.disconnect());
  }

  private async startSession(peer: JsonRpcPeer): Promise<void> {
    if (!this.userId) throw appError("not_signed_in", "Sign in to Multica Desktop to use local conversations");
    try {
      const raw = await peer.call("session.set", { userId: this.userId, apiUrl: this.options.apiUrl, env: this.options.providerEnv(), legacyDataDir: this.options.legacyDataDir });
      const session = sessionResultSchema.parse(raw);
      this.options.availability({ state: "connected", sidecar: session.status });
    } catch (error) {
      const reason = code(error);
      if (reason === "account_mismatch" || reason === "not_signed_in" || reason === "unsupported") this.options.availability({ state: "unavailable", reason });
      throw error;
    }
    const subscribed = subscribeResultSchema.parse(await peer.call("subscribe", { since: this.cursor }));
    if (subscribed.resync) this.options.resync();
    if (subscribed.cursor) this.cursor = subscribed.cursor;
  }

  private connect(): Promise<JsonRpcPeer> {
    if (this.peer) return Promise.resolve(this.peer);
    return this.connecting ??= (async () => {
      try {
        const hello = await this.hello();
        if (hello.sidecar.status === "unsupported") {
          this.options.availability({ state: "unavailable", reason: "unsupported" });
          throw appError("unsupported", "Local conversations require the daemon bundled with Multica Desktop");
        }
        const endpoint = this.endpoint!;
        const socket = new WebSocket(`ws://${endpoint.base}/local/v1/ws`, { headers: { Authorization: `Bearer ${endpoint.token}` }, maxPayload: 1 << 20 });
        await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
        const peer = new JsonRpcPeer(wsTransport(socket), (method, params) => this.handleNotification(method, params));
        void peer.closed.then(() => { if (this.peer === peer) { this.peer = undefined; this.scheduleReconnect(); } });
        try { await this.startSession(peer); } catch (error) { socket.close(); throw error; }
        this.peer = peer; this.socket = socket; this.backoff = RECONNECT_MIN_MS;
        return peer;
      } catch (error) {
        if (!code(error) || code(error) === "daemon_offline") this.options.availability({ state: "unavailable", reason: "daemon_offline" });
        if (code(error) === "incompatible") this.options.availability({ state: "unavailable", reason: "incompatible" });
        throw error;
      } finally { this.connecting = undefined; }
    })();
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.userId || this.reconnectTimer) return;
    const delay = this.backoff; this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect().catch(() => this.scheduleReconnect()); }, delay);
  }

  /** Connects eagerly so queued work and host requests reach this Desktop. */
  start(): void { void this.connect().catch(() => this.scheduleReconnect()); }

  private disconnect(): void {
    const socket = this.socket;
    this.peer = undefined; this.socket = undefined;
    socket?.close();
  }

  private async handleNotification(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "event": {
        const parsed = eventNotificationSchema.safeParse(params);
        if (!parsed.success) return undefined;
        this.cursor = parsed.data.cursor;
        const event = parsed.data.event as { type?: unknown; scope?: { userId?: unknown; workspaceId?: unknown }; sessionId?: unknown };
        if (event?.type === "changed" && typeof event.sessionId === "string" && typeof event.scope?.userId === "string" && typeof event.scope?.workspaceId === "string") {
          this.options.notify({ userId: event.scope.userId, workspaceId: event.scope.workspaceId }, event.sessionId);
        }
        return undefined;
      }
      case "resync": if (resyncNotificationSchema.safeParse(params).success) { this.cursor = ""; this.options.resync(); } return undefined;
      case "sidecarStatus": {
        const parsed = sidecarStatusNotificationSchema.safeParse(params);
        if (parsed.success) this.options.availability({ state: "connected", sidecar: parsed.data.status });
        return undefined;
      }
      case "timing": this.options.timing(params); return undefined;
      case "hostRequest": {
        const parsed = hostRequestNotificationSchema.safeParse(params);
        if (!parsed.success) return undefined;
        const { id, kind, payload } = parsed.data;
        void (async () => {
          try { await this.peer?.call("hostReply", { id, result: await this.options.hostRequest(kind, payload) ?? null }); }
          catch (error) {
            const rpc = error instanceof RpcError ? error : new RpcError(-32000, error instanceof Error ? error.message : String(error), { code: (error as { code?: string })?.code ?? "host_request_failed" });
            await this.peer?.call("hostReply", { id, error: { code: rpc.code, message: rpc.message, data: rpc.data } }).catch(() => {});
          }
        })();
        return undefined;
      }
    }
    return undefined;
  }

  async request<M extends LocalConversationMethod>(scope: LocalConversationScope, method: M, params: LocalConversationMethods[M]["params"]): Promise<LocalConversationMethods[M]["result"]> {
    const peer = await this.connect();
    return await peer.call("request", { scope: this.apiScope(scope), method, params: params ?? {} }) as LocalConversationMethods[M]["result"];
  }

  async drain(): Promise<number> {
    const peer = await this.connect().catch(() => undefined);
    if (!peer) return 0;
    return (await peer.call<{ busy: number }>("sidecar.drain", {})).busy;
  }
  async undrain(): Promise<void> { await this.peer?.call("sidecar.undrain", {}); }
  async stopSidecar(): Promise<void> { await this.peer?.call("sidecar.stop", {}); }

  /**
   * Streams one file request to the daemon's HTTP file endpoint. Only the
   * scope and file reference are forwarded; the body streams through.
   */
  async file(request: Request, scope: LocalConversationScope, fileRef: string | null): Promise<Response> {
    if (!this.endpoint) await this.hello();
    const endpoint = this.endpoint!;
    const query = new URLSearchParams(this.apiScope(scope)).toString();
    const target = fileRef === null ? `http://${endpoint.base}/local/v1/files?${query}` : `http://${endpoint.base}/local/v1/files/${encodeURIComponent(fileRef)}?${query}`;
    const headers = new Headers({ Authorization: `Bearer ${endpoint.token}` });
    for (const name of ["range", "content-type", "x-file-name"]) { const value = request.headers.get(name); if (value) headers.set(name, value); }
    return fetch(target, { method: request.method, headers, ...(request.body ? { body: request.body, duplex: "half" } : {}) } as RequestInit);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.disconnect();
  }
}
