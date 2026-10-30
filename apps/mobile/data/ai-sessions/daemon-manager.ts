import { z } from "zod";
import type { DeviceEndpoint } from "./client";

export interface NativeDaemon { start(configuration: string): Promise<string>; stop(): Promise<void> }
export interface DaemonConfiguration { registryUrl: string; apiUrl: string; token: string; userId: string; deviceName: string }
export interface DaemonState { status: "stopped" | "starting" | "ready" | "failed"; endpoint: DeviceEndpoint | null; error: string | null }
const endpointSchema = z.object({ url: z.string().refine((url) => /^http:\/\/127\.0\.0\.1:\d+$/.test(url)), token: z.string().min(1) });

/** Serializes native lifecycle operations; stale starts never expose credentials. */
export class EmbeddedDaemonManager {
  private state: DaemonState = { status: "stopped", endpoint: null, error: null };
  private listeners = new Set<() => void>();
  private revision = 0;
  private desired: DaemonConfiguration | null = null;
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private backoff = 1000;

  constructor(private native: NativeDaemon | null, private fetcher: typeof fetch = fetch) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: DaemonState) { this.state = state; for (const listener of this.listeners) listener(); }

  configure(configuration: DaemonConfiguration | null): Promise<void> {
    this.desired = configuration;
    const revision = ++this.revision;
    clearTimeout(this.timer);
    this.publish({ status: configuration ? "starting" : "stopped", endpoint: null, error: null });
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!this.native) {
        if (revision === this.revision && configuration) this.publish({ status: "failed", endpoint: null, error: "native_unavailable" });
        return;
      }
      try { await this.native.stop(); }
      catch {
        if (revision === this.revision) this.publish({ status: "failed", endpoint: null, error: "connection_failed" });
        return;
      }
      if (revision !== this.revision || !configuration) return;
      try {
        const raw = await this.native.start(JSON.stringify(configuration));
        if (revision !== this.revision) { await this.native.stop(); return; }
        const endpoint = endpointSchema.parse(JSON.parse(raw));
        this.publish({ status: "ready", endpoint, error: null });
        this.backoff = 1000;
        this.health(revision);
      } catch {
        if (revision !== this.revision) return;
        await this.native.stop().catch(() => {});
        this.publish({ status: "failed", endpoint: null, error: "connection_failed" });
        this.timer = setTimeout(() => { if (revision === this.revision) void this.configure(this.desired); }, this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30_000);
      }
    });
    return this.queue;
  }
  restart = () => this.configure(this.desired);
  stop = () => this.configure(null);

  private health(revision: number) {
    this.timer = setTimeout(() => {
      const endpoint = this.state.endpoint;
      if (revision !== this.revision || !endpoint) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      void this.fetcher(`${endpoint.url}/health`, { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: controller.signal })
        .then((response) => {
          if (revision !== this.revision) return;
          if (!response.ok) void this.restart(); else this.health(revision);
        }).catch(() => { if (revision === this.revision) void this.restart(); })
        .finally(() => clearTimeout(timeout));
    }, 15_000);
  }
}
