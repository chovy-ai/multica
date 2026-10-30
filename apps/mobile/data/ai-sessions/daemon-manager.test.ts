// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { EmbeddedDaemonManager } from "./daemon-manager";

const configuration = { userId: "account-a", token: "login-a", apiUrl: "https://api.test", registryUrl: "https://registry.test", deviceName: "iPhone" };
const endpoint = JSON.stringify({ url: "http://127.0.0.1:3456", token: "private-loopback" });
afterEach(() => vi.useRealTimers());

it("starts independently of screens, reports readiness and shuts down its endpoint", async () => {
  const native = { start: vi.fn(async (_configuration: string) => endpoint), stop: vi.fn(async () => {}) };
  const manager = new EmbeddedDaemonManager(native);
  await manager.configure(configuration);
  expect(native.start).toHaveBeenCalledWith(JSON.stringify(configuration));
  expect(manager.snapshot()).toMatchObject({ status: "ready", endpoint: { token: "private-loopback" } });
  const stopping = manager.stop();
  expect(manager.snapshot()).toMatchObject({ status: "stopped", endpoint: null });
  await stopping;
});

it("does not publish credentials from a start completed after logout", async () => {
  let resolve!: (endpoint: string) => void;
  const native = { start: vi.fn(() => new Promise<string>((done) => { resolve = done; })), stop: vi.fn(async () => {}) };
  const manager = new EmbeddedDaemonManager(native);
  const starting = manager.configure(configuration);
  await vi.waitFor(() => expect(native.start).toHaveBeenCalledOnce());
  const stopping = manager.stop();
  resolve(endpoint);
  await Promise.all([starting, stopping]);
  expect(manager.snapshot()).toEqual({ status: "stopped", endpoint: null, error: null });
  expect(native.stop.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it("serializes account replacement and never starts a stale queued account", async () => {
  const native = { start: vi.fn(async (_configuration: string) => endpoint), stop: vi.fn(async () => {}) };
  const manager = new EmbeddedDaemonManager(native);
  await Promise.all([manager.configure(configuration), manager.configure({ ...configuration, userId: "account-b", token: "login-b" })]);
  expect(native.start).toHaveBeenCalledOnce();
  expect(JSON.parse(native.start.mock.calls[0][0])).toMatchObject({ userId: "account-b", token: "login-b" });
  await manager.stop();
});

it("restarts after a failed health probe and cancels probes on background stop", async () => {
  vi.useFakeTimers();
  const native = { start: vi.fn(async (_configuration: string) => endpoint), stop: vi.fn(async () => {}) };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
  const manager = new EmbeddedDaemonManager(native, fetcher);
  await manager.configure(configuration);
  await vi.advanceTimersByTimeAsync(15000);
  expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:3456/health", expect.objectContaining({ headers: { Authorization: "Bearer private-loopback" } }));
  expect(native.start).toHaveBeenCalledTimes(2);
  await manager.stop();
  await vi.advanceTimersByTimeAsync(60000);
  expect(native.start).toHaveBeenCalledTimes(2);
});

it("backs off failed native starts and stops retrying when the app stops", async () => {
  vi.useFakeTimers();
  const native = { start: vi.fn(async () => { throw new Error("network"); }), stop: vi.fn(async () => {}) };
  const manager = new EmbeddedDaemonManager(native);
  await manager.configure(configuration);
  expect(manager.snapshot()).toMatchObject({ status: "failed", error: "connection_failed" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(native.start).toHaveBeenCalledTimes(2);
  await manager.stop(); await vi.advanceTimersByTimeAsync(30000);
  expect(native.start).toHaveBeenCalledTimes(2);
});

it("shows a missing native module explicitly and rejects non-loopback endpoints", async () => {
  const absent = new EmbeddedDaemonManager(null);
  await absent.configure(configuration);
  expect(absent.snapshot()).toMatchObject({ error: "native_unavailable" });
  const native = { start: vi.fn(async () => JSON.stringify({ url: "https://untrusted.test", token: "secret" })), stop: vi.fn(async () => {}) };
  const manager = new EmbeddedDaemonManager(native);
  await manager.configure(configuration);
  expect(manager.snapshot().endpoint).toBeNull();
  await manager.stop(); await absent.stop();
});
