import { LOCAL_V2_VERSION, localV2UploadSchema, type LocalV2ChooseRequest, type LocalV2ClientMessage, type LocalV2RendererEndpoint, type LocalV2Scope, type LocalV2Transport } from "@multica/core/local-conversation/v2";
import type { LocalHostAvailability, LocalHostUnavailableReason } from "../../../shared/local-host-availability";
import type { LocalV2Bridge } from "../../../shared/local-v2-bridge";

/** Error kinds that say why local conversations cannot be used at all. */
const BLOCKING = new Set(["daemon_offline", "not_signed_in", "account_mismatch", "device_unreachable", "device_link_off", "device_unknown", "api_url_mismatch"]);
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;
const PROBE_INTERVAL_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;

/** A failed request, carried as "kind: message" like every local v2 error. */
const failure = (kind: string, message: string) => new Error(`${kind}: ${message}`);

interface Socket {
  scope: LocalV2Scope;
  ws?: WebSocket;
  connecting?: Promise<WebSocket>;
  backoff: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface DirectLocalV2Options {
  bridge: LocalV2Bridge;
  /** "local", or the peer ID of another device reached over Device link. */
  deviceId?: string;
  /** Shows a folder picker for another device; that device has no OS picker here. */
  chooseRemote?: (scope: LocalV2Scope, request: LocalV2ChooseRequest) => Promise<unknown>;
  WebSocket?: typeof WebSocket;
  fetch?: typeof fetch;
}

/**
 * The renderer's link to the daemon's `/local/v2` API: JSON and file
 * requests with the renderer token, one WebSocket per scope opened with a
 * single-use ticket, and file URLs carrying the file key. The main process
 * only supplies those credentials, the OS picker and the native part of
 * host requests.
 */
export class DirectLocalV2Transport implements LocalV2Transport {
  private endpointValue?: LocalV2RendererEndpoint;
  private endpointLoad?: Promise<LocalV2RendererEndpoint>;
  private sockets = new Map<string, Socket>();
  private messageListeners = new Set<(scope: LocalV2Scope, message: unknown) => void>();
  private connectionListeners = new Set<(scope: LocalV2Scope, connected: boolean) => void>();
  private availabilityListeners = new Set<(value: LocalHostAvailability) => void>();
  private availabilityValue: LocalHostAvailability | null = null;
  private probeTimer?: ReturnType<typeof setInterval>;
  private readonly WS: typeof WebSocket;
  private readonly fetch: typeof fetch;
  readonly deviceId: string;
  /** Another device's API sits under this daemon's /local/devices/{peer}. */
  private readonly basePath: string;
  /** This client, so the daemon sends a conversation's host requests back here, also after a reconnect. */
  private readonly clientId = crypto.randomUUID();

  constructor(private options: DirectLocalV2Options) {
    this.WS = options.WebSocket ?? WebSocket;
    this.fetch = options.fetch ?? fetch.bind(globalThis);
    this.deviceId = options.deviceId ?? "local";
    this.basePath = this.deviceId === "local" ? "" : `/local/devices/${encodeURIComponent(this.deviceId)}`;
  }

  private endpoint(refresh = false): Promise<LocalV2RendererEndpoint> {
    if (!refresh && this.endpointValue) return Promise.resolve(this.endpointValue);
    if (refresh || !this.endpointLoad) {
      this.endpointLoad = this.options.bridge.endpoint().then((value) => { this.endpointValue = value; return value; })
        .finally(() => { this.endpointLoad = undefined; });
    }
    return this.endpointLoad;
  }

  private url(endpoint: LocalV2RendererEndpoint, path: string) { return `http://${endpoint.base}${this.basePath}/local/v2${path}`; }

  private headers(endpoint: LocalV2RendererEndpoint, scope: LocalV2Scope): Record<string, string> {
    return { Authorization: `Bearer ${endpoint.token}`, "X-Multica-API-Origin": endpoint.apiUrl, "X-Multica-User-ID": scope.userId, "X-Workspace-ID": scope.workspaceId, "X-Multica-Client-ID": this.clientId };
  }

  // --- availability ---

  availability(): LocalHostAvailability | null { return this.availabilityValue; }

  onAvailability(listener: (value: LocalHostAvailability) => void): () => void {
    this.availabilityListeners.add(listener);
    this.startProbing();
    return () => { this.availabilityListeners.delete(listener); };
  }

  private report(value: LocalHostAvailability) {
    if (JSON.stringify(value) === JSON.stringify(this.availabilityValue)) return;
    this.availabilityValue = value;
    for (const listener of this.availabilityListeners) listener(value);
  }

  /** Probes until the service works; requests and connections report changes after that. */
  private startProbing() {
    if (this.probeTimer) return;
    void this.probe();
    this.probeTimer = setInterval(() => { if (this.availabilityValue?.state !== "connected") void this.probe(); }, PROBE_INTERVAL_MS);
  }

  /** Checks that the daemon serves this API version. */
  async probe(): Promise<void> {
    let response: Response;
    try {
      const endpoint = await this.endpoint(true);
      response = await this.fetch(this.url(endpoint, "/hello"), { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(this.deviceId === "local" ? 5000 : HANDSHAKE_TIMEOUT_MS) });
    } catch { this.report({ state: "unavailable", reason: "daemon_offline" }); return; }
    if (response.status === 404) { this.report({ state: "unavailable", reason: "unsupported" }); return; }
    if (!response.ok) {
      const kind = (await response.json().catch(() => null) as { error?: { kind?: unknown } } | null)?.error?.kind;
      this.report({ state: "unavailable", reason: typeof kind === "string" && BLOCKING.has(kind) ? kind as LocalHostUnavailableReason : "daemon_offline" });
      return;
    }
    const hello = await response.json().catch(() => null) as { version?: unknown } | null;
    const capabilities = Array.isArray((hello as { capabilities?: unknown } | null)?.capabilities) ? (hello as { capabilities: unknown[] }).capabilities : [];
    const compatible = hello?.version === LOCAL_V2_VERSION && (this.deviceId === "local" || capabilities.includes("device-link"));
    this.report(compatible ? { state: "connected" } : { state: "unavailable", reason: "incompatible" });
  }

  private outcome(kind: string | null) {
    if (kind === null) this.report({ state: "connected" });
    else if (kind === "draining") this.report({ state: "updating" });
    else if (BLOCKING.has(kind)) this.report({ state: "unavailable", reason: kind as LocalHostUnavailableReason });
  }

  // --- requests ---

  /** One authenticated request; credentials refused once are read again. */
  private async fetchDaemon(scope: LocalV2Scope, method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
    if (!path.startsWith("/") || path.includes("..")) throw failure("invalid_request", "Invalid local conversation path");
    for (let attempt = 0; attempt < 2; attempt++) {
      let endpoint: LocalV2RendererEndpoint;
      let response: Response;
      try {
        endpoint = await this.endpoint(attempt > 0);
        response = await this.fetch(this.url(endpoint, path), { method, headers: { ...this.headers(endpoint, scope), ...init.headers }, body: init.body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch {
        this.outcome("daemon_offline");
        throw failure("daemon_offline", "Start the local daemon to use local conversations");
      }
      // The daemon restarted with a new token, or moved to another port.
      if (response.status === 403 && attempt === 0 && !(response.headers.get("Content-Type") ?? "").includes("json")) continue;
      return response;
    }
    throw failure("forbidden", "The local daemon refused the connection");
  }

  private async json(scope: LocalV2Scope, method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<unknown> {
    const response = await this.fetchDaemon(scope, method, path, init);
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (value as { error?: { kind?: unknown; message?: unknown } } | null)?.error;
      const kind = typeof error?.kind === "string" ? error.kind : `http_${response.status}`;
      this.outcome(kind);
      throw failure(kind, typeof error?.message === "string" ? error.message : `Local conversation request failed (HTTP ${response.status})`);
    }
    this.outcome(null);
    return value;
  }

  request(scope: LocalV2Scope, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    return this.json(scope, method, path, body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  }

  async upload(scope: LocalV2Scope, file: File) {
    const raw = await this.json(scope, "POST", "/attachments", { body: file, headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) } });
    return localV2UploadSchema.parse(raw);
  }

  /**
   * A file URL for <img>, <video> and previews. Files are shown only after
   * the conversation that names them was read, so the endpoint is known by
   * then; a URL from before a daemon restart stops working and the view
   * reloads with the restart.
   */
  fileUrl(scope: LocalV2Scope, path: string): string {
    const endpoint = this.endpointValue;
    if (!endpoint) return "";
    const params = new URLSearchParams({ file_key: endpoint.fileKey, api_origin: endpoint.apiUrl, user_id: scope.userId, workspace_id: scope.workspaceId });
    return `${this.url(endpoint, path)}${path.includes("?") ? "&" : "?"}${params}`;
  }

  choose(scope: LocalV2Scope, request: LocalV2ChooseRequest) {
    if (this.deviceId === "local") return this.options.bridge.choose(scope, request);
    if (!this.options.chooseRemote) return Promise.reject(failure("unsupported", "Choose a folder on this device"));
    return this.options.chooseRemote(scope, request);
  }

  // --- this device's Device link (local transport only) ---

  private async own(method: string, path: string, body?: unknown): Promise<unknown> {
    const endpoint = await this.endpoint();
    const response = await this.fetch(`http://${endpoint.base}${path}`, { method, headers: { Authorization: `Bearer ${endpoint.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) throw failure(`http_${response.status}`, "The local daemon refused the request");
    return value;
  }

  /** The account's other devices that are connected and share their conversations. */
  devices(): Promise<unknown> { return this.own("GET", "/local/devices"); }

  /** Whether this device shares its conversations, and whether it can. */
  deviceLink(): Promise<unknown> { return this.own("GET", "/local/device-link"); }

  setDeviceLink(enabled: boolean): Promise<unknown> { return this.own("PUT", "/local/device-link", { enabled }); }

  servicePreview(): Promise<unknown> { return this.own("GET", "/local/service-preview"); }
  setServicePreview(value: { enabled: boolean; ports: number[] }): Promise<unknown> { return this.own("PUT", "/local/service-preview", value); }
  clearAgentServicePreviews(): Promise<unknown> { return this.own("DELETE", "/local/service-preview"); }

  // --- WebSocket ---

  subscribe(listener: (scope: LocalV2Scope, message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }

  onConnection(listener: (scope: LocalV2Scope, connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => { this.connectionListeners.delete(listener); };
  }

  async send(scope: LocalV2Scope, message: LocalV2ClientMessage): Promise<void> {
    const ws = await this.connect(scope);
    ws.send(JSON.stringify(message));
  }

  private key(scope: LocalV2Scope) { return JSON.stringify([scope.userId, scope.workspaceId]); }

  private connect(scope: LocalV2Scope): Promise<WebSocket> {
    const key = this.key(scope);
    let socket = this.sockets.get(key);
    if (!socket) { socket = { scope, backoff: RECONNECT_MIN_MS }; this.sockets.set(key, socket); }
    if (socket.ws?.readyState === this.WS.OPEN) return Promise.resolve(socket.ws);
    const current = socket;
    return current.connecting ??= (async () => {
      try {
        const { ticket } = await this.json(scope, "POST", "/ws-ticket") as { ticket: string };
        const endpoint = await this.endpoint();
        if (this.sockets.get(key) !== current) throw failure("scope_released", "The conversation connection was released");
        const ws = new this.WS(`ws://${endpoint.base}${this.basePath}/local/v2/ws?${new URLSearchParams({ ticket })}`);
        current.ws = ws;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            ws.removeEventListener("open", opened); ws.removeEventListener("close", closed);
            if (error) {
              reject(error);
              // Keep the error listener for the close of a still-connecting socket.
              if (ws.readyState === this.WS.CONNECTING) ws.close();
            } else { ws.removeEventListener("error", failed); resolve(); }
          };
          const opened = () => finish();
          const closed = () => finish(failure("device_unreachable", "The connection closed before the handshake completed"));
          const failed = () => finish(failure(this.deviceId === "local" ? "daemon_offline" : "device_unreachable", "Could not connect to the conversation service"));
          const timer = setTimeout(() => finish(failure("device_unreachable", "The conversation connection handshake timed out")), HANDSHAKE_TIMEOUT_MS);
          ws.addEventListener("open", opened, { once: true });
          ws.addEventListener("close", closed, { once: true });
          ws.addEventListener("error", failed, { once: true });
        });
        if (this.sockets.get(key) !== current || ws.readyState !== this.WS.OPEN) {
          ws.close(); throw failure("scope_released", "The conversation connection was released");
        }
        this.attach(current, ws);
        return ws;
      } catch (error) {
        current.ws = undefined;
        if (this.sockets.get(key) === current) {
          if (this.availabilityValue?.state !== "unavailable") this.outcome(this.deviceId === "local" ? "daemon_offline" : "device_unreachable");
          for (const listener of this.connectionListeners) listener(scope, false);
          this.reconnect(current);
        }
        throw error;
      } finally { current.connecting = undefined; }
    })();
  }

  private attach(socket: Socket, ws: WebSocket) {
    socket.ws = ws; socket.backoff = RECONNECT_MIN_MS;
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: unknown;
      try { message = JSON.parse(event.data); } catch { return; }
      const value = message as { type?: unknown; request_id?: unknown; kind?: unknown; payload?: unknown };
      if (value?.type === "host.request" && typeof value.request_id === "string" && typeof value.kind === "string") {
        void this.answer(socket.scope, ws, value.request_id, value.kind, (value.payload ?? {}) as Record<string, unknown>);
        return;
      }
      for (const listener of this.messageListeners) listener(socket.scope, message);
    });
    ws.addEventListener("close", () => {
      if (this.sockets.get(this.key(socket.scope)) !== socket || socket.ws !== ws) return;
      socket.ws = undefined;
      this.outcome(this.deviceId === "local" ? "daemon_offline" : "device_unreachable");
      for (const listener of this.connectionListeners) listener(socket.scope, false);
      this.reconnect(socket);
    }, { once: true });
    this.outcome(null);
    for (const listener of this.connectionListeners) listener(socket.scope, true);
  }

  private async answer(scope: LocalV2Scope, ws: WebSocket, requestId: string, kind: string, payload: Record<string, unknown>) {
    let reply: Record<string, unknown>;
    try {
      reply = { result: (await this.options.bridge.hostRequest(this.deviceId, scope, kind, payload)) ?? null };
    } catch (error) {
      const text = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(error);
      const match = /^([a-z][a-z0-9_]*): ([\s\S]*)$/.exec(text);
      reply = { error: { kind: match?.[1] ?? "host_request_failed", message: match?.[2] ?? text } };
    }
    if (ws.readyState === this.WS.OPEN) ws.send(JSON.stringify({ version: LOCAL_V2_VERSION, type: "host.reply", request_id: requestId, ...reply }));
  }

  private reconnect(socket: Socket) {
    if (socket.timer || this.sockets.get(this.key(socket.scope)) !== socket) return;
    const delay = socket.backoff; socket.backoff = Math.min(socket.backoff * 2, RECONNECT_MAX_MS);
    socket.timer = setTimeout(() => {
      socket.timer = undefined;
      void this.connect(socket.scope).catch(() => this.reconnect(socket));
    }, delay);
  }

  /** Stops keeping a scope connected, e.g. after the account changed. */
  release(scope: LocalV2Scope): void {
    const socket = this.sockets.get(this.key(scope));
    if (!socket) return;
    this.sockets.delete(this.key(scope));
    if (socket.timer) clearTimeout(socket.timer);
    socket.ws?.close();
    for (const listener of this.connectionListeners) listener(scope, false);
  }
}

const transports = new Map<string, DirectLocalV2Transport>();
let remoteChooser: ((deviceId: string, scope: LocalV2Scope, request: LocalV2ChooseRequest) => Promise<unknown>) | undefined;

/** Sets how folders are chosen on other devices; the conversation page provides its picker. */
export function setRemoteFolderChooser(choose: typeof remoteChooser) { remoteChooser = choose; }

/**
 * This window's transport to the conversations of a device: this one by
 * default, or another device of the account through this daemon.
 */
export function localV2Transport(deviceId = "local"): DirectLocalV2Transport {
  let transport = transports.get(deviceId);
  if (!transport) {
    transport = new DirectLocalV2Transport({ bridge: window.desktopAPI.localV2, deviceId,
      chooseRemote: (scope, request) => remoteChooser ? remoteChooser(deviceId, scope, request) : Promise.reject(new Error("unsupported: Open the device's conversations to choose a folder")) });
    transports.set(deviceId, transport);
  }
  return transport;
}
