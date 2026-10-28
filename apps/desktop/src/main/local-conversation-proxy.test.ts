// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { JsonRpcPeer, appError } from "../local-host/json-rpc";
import { LocalHostProxy, type LocalHostProxyOptions } from "./local-conversation-proxy";

const TOKEN = "proxy-test-token";
const scope = { userId: "user", workspaceId: "ws" };

interface FakeDaemon { server: Server; base: string; peers: JsonRpcPeer[]; sockets: WebSocket[]; calls: { method: string; params: unknown }[]; hello: Record<string, unknown>; close(): Promise<void> }

async function fakeDaemon(handle: (method: string, params: unknown, peer: JsonRpcPeer) => unknown = () => ({})): Promise<FakeDaemon> {
  const daemon = { peers: [] as JsonRpcPeer[], sockets: [] as WebSocket[], calls: [] as { method: string; params: unknown }[], hello: { apiVersion: 1, sidecarProtocolVersion: 2, capabilities: ["ws"], sidecar: { status: "ready", instance: "i1", busy: 0, crashes: 0 } } } as unknown as FakeDaemon;
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(403).end(); return; }
    if (req.url === "/local/v1/hello") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(daemon.hello)); return; }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      daemon.sockets.push(ws);
      const peer: JsonRpcPeer = new JsonRpcPeer({
        send: (text) => ws.send(text),
        onMessage: (listener) => ws.on("message", (data) => listener(data.toString())),
        onClose: (listener) => ws.once("close", listener),
      }, async (method, params) => { daemon.calls.push({ method, params }); return handle(method, params, peer); });
      daemon.peers.push(peer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  daemon.server = server;
  daemon.base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  daemon.close = async () => { for (const ws of daemon.sockets) ws.terminate(); wss.close(); await new Promise((resolve) => server.close(resolve)); };
  return daemon;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function proxyFor(daemon: FakeDaemon, overrides: Partial<LocalHostProxyOptions> = {}) {
  const options = {
    apiUrl: "https://api.example", profile: "desktop-test", legacyDataDir: "/legacy",
    providerEnv: () => ({ PATH: "/bin" }), notify: vi.fn(), resync: vi.fn(), availability: vi.fn(), timing: vi.fn(),
    hostRequest: vi.fn(async () => ({ path: "/picked" })),
    endpoint: async () => ({ base: daemon.base, token: TOKEN }),
    ...overrides,
  } satisfies LocalHostProxyOptions;
  const proxy = new LocalHostProxy(options);
  cleanups.push(() => proxy.close());
  return { proxy, options };
}

const handler = (method: string) => {
  if (method === "session.set") return { connectionId: "c1", status: "ready", instance: "i1" };
  if (method === "subscribe") return { cursor: "", resync: false };
  if (method === "request") return [{ id: "conv" }];
  return {};
};

describe("local host proxy", () => {
  it("rejects an incompatible sidecar protocol before opening a socket", async () => {
    const daemon = await fakeDaemon(handler); cleanups.push(() => daemon.close());
    daemon.hello.sidecarProtocolVersion = 99;
    const { proxy } = proxyFor(daemon); proxy.setUser("user");
    await expect(proxy.request(scope, "list", {})).rejects.toMatchObject({ data: { code: "incompatible" } });
    expect(daemon.sockets).toHaveLength(0);
  });
  it("opens a session for the signed-in account and routes requests with the API scope", async () => {
    const daemon = await fakeDaemon(handler); cleanups.push(() => daemon.close());
    const { proxy, options } = proxyFor(daemon);
    proxy.setUser("user");
    expect(await proxy.request(scope, "list", {})).toEqual([{ id: "conv" }]);
    expect(daemon.calls.map((call) => call.method)).toEqual(["session.set", "subscribe", "request"]);
    expect(daemon.calls[0]!.params).toEqual({ userId: "user", apiUrl: "https://api.example", env: { PATH: "/bin" }, legacyDataDir: "/legacy" });
    expect(daemon.calls[2]!.params).toEqual({ scope: { apiUrl: "https://api.example", userId: "user", workspaceId: "ws" }, method: "list", params: {} });
    expect(options.availability).toHaveBeenCalledWith({ state: "connected", sidecar: "ready" });
  });

  it("forwards change events and resync to the renderer, and answers host requests", async () => {
    const daemon = await fakeDaemon(handler); cleanups.push(() => daemon.close());
    const { proxy, options } = proxyFor(daemon);
    proxy.setUser("user");
    await proxy.request(scope, "list", {});
    const peer = daemon.peers[0]!;
    peer.notify("event", { cursor: "i1:1", event: { type: "changed", scope: { apiUrl: "https://api.example", ...scope }, sessionId: "conv" } });
    peer.notify("resync", { instance: "i2" });
    await vi.waitFor(() => expect(options.notify).toHaveBeenCalledWith(scope, "conv"));
    await vi.waitFor(() => expect(options.resync).toHaveBeenCalled());
    peer.notify("hostRequest", { id: "h1", kind: "pick_directory", payload: { current: "/" } });
    await vi.waitFor(() => expect(daemon.calls).toContainEqual({ method: "hostReply", params: { id: "h1", result: { path: "/picked" } } }));
    expect(options.hostRequest).toHaveBeenCalledWith("pick_directory", { current: "/" });
  });

  it("returns a failed host request as an error reply instead of leaving the daemon waiting", async () => {
    const daemon = await fakeDaemon(handler); cleanups.push(() => daemon.close());
    const { proxy } = proxyFor(daemon, { hostRequest: async () => { throw appError("settings_host_unavailable", "Open the main app"); } });
    proxy.setUser("user");
    await proxy.request(scope, "list", {});
    daemon.peers[0]!.notify("hostRequest", { id: "h2", kind: "confirmed_operation", payload: {} });
    await vi.waitFor(() => expect(daemon.calls.find((call) => call.method === "hostReply")?.params).toMatchObject({ id: "h2", error: { code: -32000, message: "Open the main app", data: { code: "settings_host_unavailable" } } }));
  });

  it("reports why local conversations are unavailable", async () => {
    const daemon = await fakeDaemon((method) => method === "session.set" ? Promise.reject(appError("account_mismatch", "other account")) : handler(method)); cleanups.push(() => daemon.close());
    const { proxy, options } = proxyFor(daemon);
    proxy.setUser("user");
    await expect(proxy.request(scope, "list", {})).rejects.toMatchObject({ data: { code: "account_mismatch" } });
    expect(options.availability).toHaveBeenCalledWith({ state: "unavailable", reason: "account_mismatch" });

    daemon.hello = { apiVersion: 1, sidecar: { status: "unsupported" } };
    await expect(proxy.request(scope, "list", {})).rejects.toMatchObject({ data: { code: "unsupported" } });
    expect(options.availability).toHaveBeenCalledWith({ state: "unavailable", reason: "unsupported" });
  });

  it("re-reads a rotated token and reconnects after the daemon drops the socket", async () => {
    const daemon = await fakeDaemon(handler); cleanups.push(() => daemon.close());
    let token = "stale";
    const { proxy } = proxyFor(daemon, { endpoint: async () => { const current = { base: daemon.base, token }; token = TOKEN; return current; } });
    proxy.setUser("user");
    expect(await proxy.request(scope, "list", {})).toEqual([{ id: "conv" }]);
    daemon.sockets[0]!.terminate();
    await vi.waitFor(() => expect(daemon.peers.length).toBe(2), { timeout: 5000 });
    expect(await proxy.request(scope, "list", {})).toEqual([{ id: "conv" }]);
  });

  it("fails clearly when the daemon is not running", async () => {
    const { proxy, options } = proxyFor({ base: "127.0.0.1:1" } as FakeDaemon);
    proxy.setUser("user");
    await expect(proxy.request(scope, "list", {})).rejects.toMatchObject({ data: { code: "daemon_offline" } });
    expect(options.availability).toHaveBeenCalledWith({ state: "unavailable", reason: "daemon_offline" });
  });
});
