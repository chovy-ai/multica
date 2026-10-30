import WebSocket from "ws";
import type { LocalConversationScope } from "@multica/core/local-conversation/protocol";
import { LOCAL_V2_VERSION } from "@multica/core/local-conversation/v2";
import type { LocalHostAvailability } from "../shared/local-host-availability";

/** The daemon's verified endpoint and token; the token never leaves main. */
export interface LocalV2Endpoint { base: string; token: string }

export interface LocalV2ProxyOptions {
  apiUrl: string;
  endpoint(): Promise<LocalV2Endpoint>;
  /** Forwards a daemon WS message of a scope to the renderer. */
  message(scope: LocalConversationScope, message: unknown): void;
  /** The scope's WS connected or disconnected; the renderer resubscribes on connect. */
  connection(scope: LocalConversationScope, connected: boolean): void;
  /** Performs a daemon host request for a scope and returns its result. */
  hostRequest(scope: LocalConversationScope, kind: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Whether local conversations work, as each request and connection finds out. */
  availability?(value: LocalHostAvailability): void;
}

/** Error kinds that say why local conversations cannot be used at all. */
const BLOCKING = new Set(["daemon_offline", "not_signed_in", "account_mismatch"]);

/** A v2 request failure with the daemon's stable error kind. */
export class LocalV2Error extends Error {
  constructor(readonly kind: string, message: string, readonly status: number) { super(message); }
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;

interface Socket {
  scope: LocalConversationScope;
  ws?: WebSocket;
  connecting?: Promise<WebSocket>;
  backoff: number;
  timer?: ReturnType<typeof setTimeout>;
  wanted: boolean;
}

/**
 * Desktop's link to the daemon's `/local/v2` API: authenticated JSON and
 * file requests, and one WebSocket per scope whose messages go to the
 * renderer. Subscription state and cursors live in the renderer, which
 * resubscribes after each reconnect; host requests are answered here.
 */
export class LocalV2Proxy {
  private endpointValue?: LocalV2Endpoint;
  private sockets = new Map<string, Socket>();
  private closed = false;
  private state?: string;

  constructor(private options: LocalV2ProxyOptions) {}

  private key(scope: LocalConversationScope) { return JSON.stringify([scope.userId, scope.workspaceId]); }

  private async endpoint(refresh = false): Promise<LocalV2Endpoint> {
    if (refresh || !this.endpointValue) this.endpointValue = await this.options.endpoint();
    return this.endpointValue;
  }

  private report(value: LocalHostAvailability) {
    const key = JSON.stringify(value);
    if (key === this.state) return;
    this.state = key;
    this.options.availability?.(value);
  }

  /** Reports a request's outcome: success means the service works. */
  private outcome<T>(result: Promise<T>): Promise<T> {
    return result.then((value) => { this.report({ state: "connected" }); return value; }, (error: unknown) => {
      if (error instanceof LocalV2Error) {
        if (error.kind === "draining") this.report({ state: "updating" });
        else if (BLOCKING.has(error.kind)) this.report({ state: "unavailable", reason: error.kind as "daemon_offline" | "not_signed_in" | "account_mismatch" });
      }
      throw error;
    });
  }

  /**
   * Checks that the daemon serves this API version. A daemon without local
   * conversations has no `/local/v2` routes.
   */
  async probe(): Promise<void> {
    let response: Response;
    try {
      const endpoint = await this.endpoint(true);
      response = await fetch(`http://${endpoint.base}/local/v2/hello`, { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(5000) });
    } catch { this.report({ state: "unavailable", reason: "daemon_offline" }); return; }
    if (response.status === 404) { this.report({ state: "unavailable", reason: "unsupported" }); return; }
    if (!response.ok) { this.report({ state: "unavailable", reason: "daemon_offline" }); return; }
    const hello = await response.json().catch(() => null) as { version?: unknown } | null;
    this.report(hello?.version === LOCAL_V2_VERSION ? { state: "connected" } : { state: "unavailable", reason: "incompatible" });
  }

  private headers(scope: LocalConversationScope, token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, "X-Multica-API-Origin": this.options.apiUrl, "X-Multica-User-ID": scope.userId, "X-Workspace-ID": scope.workspaceId };
  }

  /** One JSON request. A rotated token is re-read once. */
  request(scope: LocalConversationScope, method: string, path: string, body?: unknown): Promise<unknown> {
    return this.outcome(this.requestOnce(scope, method, path, body));
  }

  private async requestOnce(scope: LocalConversationScope, method: string, path: string, body?: unknown): Promise<unknown> {
    if (!path.startsWith("/") || path.includes("..")) throw new LocalV2Error("invalid_request", "Invalid local conversation path", 400);
    for (let attempt = 0; attempt < 2; attempt++) {
      const endpoint = await this.endpoint(attempt > 0);
      let response: Response;
      try {
        response = await fetch(`http://${endpoint.base}/local/v2${path}`, {
          method, headers: { ...this.headers(scope, endpoint.token), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new LocalV2Error("daemon_offline", "Start the local daemon to use local conversations", 0);
      }
      if (response.status === 403 && attempt === 0) continue;
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = (value as { error?: { kind?: unknown; message?: unknown } } | null)?.error;
        throw new LocalV2Error(typeof error?.kind === "string" ? error.kind : `http_${response.status}`, typeof error?.message === "string" ? error.message : `Local conversation request failed (HTTP ${response.status})`, response.status);
      }
      return value;
    }
    throw new LocalV2Error("forbidden", "The local daemon refused the connection", 403);
  }

  /** Streams a file request (an upload or a download) to the daemon. */
  async file(request: Request, scope: LocalConversationScope, path: string): Promise<Response> {
    const endpoint = await this.endpoint();
    const headers = new Headers(this.headers(scope, endpoint.token));
    for (const name of ["range", "content-type", "x-file-name"]) { const value = request.headers.get(name); if (value) headers.set(name, value); }
    return fetch(`http://${endpoint.base}/local/v2${path}`, { method: request.method, headers, ...(request.body ? { body: request.body, duplex: "half" } : {}) } as RequestInit);
  }

  /** Sends a client message on the scope's WebSocket, connecting first. */
  async send(scope: LocalConversationScope, message: unknown): Promise<void> {
    const ws = await this.connect(scope);
    ws.send(JSON.stringify(message));
  }

  private socket(scope: LocalConversationScope): Socket {
    const key = this.key(scope);
    let socket = this.sockets.get(key);
    if (!socket) { socket = { scope, backoff: RECONNECT_MIN_MS, wanted: true }; this.sockets.set(key, socket); }
    socket.wanted = true;
    return socket;
  }

  private connect(scope: LocalConversationScope): Promise<WebSocket> {
    const socket = this.socket(scope);
    if (socket.ws?.readyState === WebSocket.OPEN) return Promise.resolve(socket.ws);
    return socket.connecting ??= (async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const endpoint = await this.endpoint(attempt > 0);
          const ws = new WebSocket(`ws://${endpoint.base}/local/v2/ws`, { headers: this.headers(scope, endpoint.token), maxPayload: 64 * 1024 * 1024 });
          const opened = await new Promise<boolean>((resolve, reject) => {
            ws.once("open", () => resolve(true));
            ws.once("unexpected-response", (_request, response) => {
              ws.terminate();
              if (response.statusCode === 403 && attempt === 0) resolve(false);
              else reject(new LocalV2Error("daemon_offline", "The local daemon refused the connection", response.statusCode ?? 0));
            });
            ws.once("error", () => reject(new LocalV2Error("daemon_offline", "Start the local daemon to use local conversations", 0)));
          });
          if (!opened) continue;
          this.report({ state: "connected" });
          this.attach(socket, ws);
          return ws;
        }
        throw new LocalV2Error("forbidden", "The local daemon refused the connection", 403);
      } catch (error) {
        if (error instanceof LocalV2Error && error.kind === "daemon_offline") this.report({ state: "unavailable", reason: "daemon_offline" });
        throw error;
      } finally { socket.connecting = undefined; }
    })();
  }

  private attach(socket: Socket, ws: WebSocket) {
    socket.ws = ws; socket.backoff = RECONNECT_MIN_MS;
    ws.on("message", (data, binary) => {
      if (binary) return;
      let message: unknown;
      try { message = JSON.parse(data.toString()); } catch { return; }
      const value = message as { type?: unknown; request_id?: unknown; kind?: unknown; payload?: unknown };
      if (value?.type === "host.request" && typeof value.request_id === "string" && typeof value.kind === "string") {
        void this.answer(socket, ws, value.request_id, value.kind, (value.payload ?? {}) as Record<string, unknown>);
        return;
      }
      this.options.message(socket.scope, message);
    });
    ws.once("close", () => {
      if (socket.ws === ws) socket.ws = undefined;
      this.options.connection(socket.scope, false);
      this.reconnect(socket);
    });
    this.options.connection(socket.scope, true);
  }

  private async answer(socket: Socket, ws: WebSocket, requestId: string, kind: string, payload: Record<string, unknown>) {
    let reply: Record<string, unknown>;
    try {
      reply = { result: (await this.options.hostRequest(socket.scope, kind, payload)) ?? null };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      reply = { error: { kind: typeof code === "string" ? code : "host_request_failed", message: error instanceof Error ? error.message : String(error) } };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ version: 2, type: "host.reply", request_id: requestId, ...reply }));
  }

  private reconnect(socket: Socket) {
    if (this.closed || !socket.wanted || socket.timer) return;
    const delay = socket.backoff; socket.backoff = Math.min(socket.backoff * 2, RECONNECT_MAX_MS);
    socket.timer = setTimeout(() => {
      socket.timer = undefined;
      void this.connect(socket.scope).catch(() => this.reconnect(socket));
    }, delay);
  }

  /** Stops keeping a scope connected, e.g. after the account changed. */
  release(scope: LocalConversationScope): void {
    const socket = this.sockets.get(this.key(scope));
    if (!socket) return;
    socket.wanted = false;
    if (socket.timer) clearTimeout(socket.timer);
    this.sockets.delete(this.key(scope));
    socket.ws?.close();
  }

  /** Drains the daemon's service before a restart; returns its running turns. */
  async drain(): Promise<number> {
    const endpoint = await this.endpoint();
    const response = await fetch(`http://${endpoint.base}/local/v2/drain`, { method: "POST", headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return 0;
    if (!response.ok) throw new LocalV2Error(`http_${response.status}`, "The local daemon did not drain", response.status);
    return Number(((await response.json()) as { busy?: unknown }).busy) || 0;
  }

  /** Stops the provider processes of a drained service, e.g. before an app update. */
  async stopProviders(): Promise<void> {
    const endpoint = await this.endpoint();
    await fetch(`http://${endpoint.base}/local/v2/stop-providers`, { method: "POST", headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(30_000) });
  }

  async undrain(): Promise<void> {
    const endpoint = await this.endpoint();
    await fetch(`http://${endpoint.base}/local/v2/undrain`, { method: "POST", headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(10_000) });
  }

  close(): void {
    this.closed = true;
    for (const socket of [...this.sockets.values()]) this.release(socket.scope);
  }
}
