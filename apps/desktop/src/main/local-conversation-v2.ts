import { createHmac } from "node:crypto";
import type { LocalConversationScope } from "@multica/core/local-conversation/protocol";
import type { LocalV2RendererEndpoint } from "@multica/core/local-conversation/v2";

/** The daemon's verified endpoint and token; the token never leaves main. */
export interface LocalV2Endpoint { base: string; token: string }

export interface LocalV2ClientOptions {
  apiUrl: string;
  endpoint(): Promise<LocalV2Endpoint>;
}

/** A v2 request failure with the daemon's stable error kind. */
export class LocalV2Error extends Error {
  constructor(readonly kind: string, message: string, readonly status: number) { super(message); }
}

const REQUEST_TIMEOUT_MS = 120_000;

// Must match localhost.RendererToken and localhost.FileKey in the daemon.
const derive = (token: string, purpose: string) => createHmac("sha256", token).update(purpose).digest("hex");

/**
 * The main process's client of the daemon's `/local/v2` API, holding the
 * profile token. The renderer talks to the daemon directly with credentials
 * derived from it; main keeps only the routes the renderer may not use
 * (folders chosen in the OS picker, drain) and its own reads.
 */
export class LocalV2Client {
  private endpointValue?: LocalV2Endpoint;

  constructor(private options: LocalV2ClientOptions) {}

  private async endpoint(refresh = false): Promise<LocalV2Endpoint> {
    if (refresh || !this.endpointValue) this.endpointValue = await this.options.endpoint();
    return this.endpointValue;
  }

  /** What the renderer needs to reach the daemon: never the profile token itself. */
  async rendererEndpoint(): Promise<LocalV2RendererEndpoint> {
    const { base, token } = await this.endpoint(true);
    return { base, apiUrl: this.options.apiUrl, token: derive(token, "multica-local-renderer"), fileKey: derive(token, "multica-local-file") };
  }

  private headers(scope: LocalConversationScope, token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, "X-Multica-API-Origin": this.options.apiUrl, "X-Multica-User-ID": scope.userId, "X-Workspace-ID": scope.workspaceId };
  }

  /**
   * One JSON request to this device, or with deviceId to another device of
   * the account through this daemon. A rotated token is re-read once.
   */
  async request(scope: LocalConversationScope, method: string, path: string, body?: unknown, deviceId = "local"): Promise<unknown> {
    if (!path.startsWith("/") || path.includes("..")) throw new LocalV2Error("invalid_request", "Invalid local conversation path", 400);
    for (let attempt = 0; attempt < 2; attempt++) {
      const endpoint = await this.endpoint(attempt > 0);
      let response: Response;
      try {
        const base = deviceId === "local" ? "" : `/local/devices/${encodeURIComponent(deviceId)}`;
        response = await fetch(`http://${endpoint.base}${base}/local/v2${path}`, {
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

  /** The name another device of the account registered, for dialogs about it. */
  async deviceName(deviceId: string): Promise<string> {
    const endpoint = await this.endpoint();
    const response = await fetch(`http://${endpoint.base}/local/devices`, { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(5000) });
    const body = await response.json().catch(() => null) as { devices?: { peer_id?: unknown; device_name?: unknown }[] } | null;
    const name = body?.devices?.find((device) => device.peer_id === deviceId)?.device_name;
    return typeof name === "string" && name ? name : deviceId;
  }

  /** Streams a file route of this device or, with deviceId, another one. */
  async file(scope: LocalConversationScope, path: string, deviceId = "local"): Promise<Response> {
    const endpoint = await this.endpoint();
    const base = deviceId === "local" ? "" : `/local/devices/${encodeURIComponent(deviceId)}`;
    return fetch(`http://${endpoint.base}${base}/local/v2${path}`, { headers: this.headers(scope, endpoint.token) });
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
}
