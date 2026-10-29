// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { LocalV2Error, LocalV2Proxy, type LocalV2ProxyOptions } from "./local-conversation-v2";

const scope = { userId: "user", workspaceId: "ws" };

interface Daemon { server: Server; base: string; token: string; sockets: WebSocket[]; requests: IncomingMessage[]; received: unknown[]; close(): Promise<void> }

async function fakeDaemon(): Promise<Daemon> {
  const daemon = { token: "t1", sockets: [], requests: [], received: [] } as unknown as Daemon;
  const wss = new WebSocketServer({ noServer: true });
  daemon.server = createServer((req, res) => {
    daemon.requests.push(req);
    if (req.headers.authorization !== `Bearer ${daemon.token}`) { res.writeHead(403).end(); return; }
    if (req.url === "/local/v2/sessions/missing/snapshot") { res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { kind: "not_found", message: "conversation missing" } })); return; }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ path: req.url, method: req.method, body: body ? JSON.parse(body) : null })));
  });
  daemon.server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${daemon.token}`) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      daemon.sockets.push(ws);
      ws.on("message", (data) => daemon.received.push(JSON.parse(data.toString())));
    });
  });
  await new Promise<void>((resolve) => daemon.server.listen(0, "127.0.0.1", resolve));
  daemon.base = `127.0.0.1:${(daemon.server.address() as AddressInfo).port}`;
  daemon.close = async () => { for (const ws of daemon.sockets) ws.terminate(); wss.close(); await new Promise<void>((resolve) => daemon.server.close(() => resolve())); };
  return daemon;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(overrides: Partial<LocalV2ProxyOptions> = {}) {
  const daemon = await fakeDaemon();
  let token = daemon.token;
  const options: LocalV2ProxyOptions = {
    apiUrl: "https://api.multica.ai",
    endpoint: vi.fn(async () => ({ base: daemon.base, token })),
    message: vi.fn(), connection: vi.fn(), hostRequest: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  const proxy = new LocalV2Proxy(options);
  cleanups.push(() => proxy.close(), () => daemon.close());
  return { daemon, proxy, options, rotate: (next: string) => { token = next; } };
}

const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); expect(check()).toBe(true); };

describe("LocalV2Proxy", () => {
  it("sends scoped, authenticated requests and keeps the daemon's error kinds", async () => {
    const { daemon, proxy } = await setup();
    expect(await proxy.request(scope, "POST", "/sessions/c1/commands", { type: "send" })).toEqual({ path: "/local/v2/sessions/c1/commands", method: "POST", body: { type: "send" } });
    const headers = daemon.requests[0]!.headers;
    expect(headers["x-multica-user-id"]).toBe("user");
    expect(headers["x-workspace-id"]).toBe("ws");
    expect(headers["x-multica-api-origin"]).toBe("https://api.multica.ai");
    await expect(proxy.request(scope, "GET", "/sessions/missing/snapshot")).rejects.toMatchObject({ kind: "not_found", status: 404 });
    await expect(proxy.request(scope, "GET", "/../v1/hello")).rejects.toBeInstanceOf(LocalV2Error);
  });

  it("re-reads a rotated token once", async () => {
    const { daemon, proxy, options, rotate } = await setup();
    await proxy.request(scope, "GET", "/hello");
    daemon.token = "t2"; rotate("t2");
    await proxy.request(scope, "GET", "/hello");
    expect(options.endpoint).toHaveBeenCalledTimes(2);
  });

  it("relays WS messages and answers host requests on the same socket", async () => {
    const { daemon, proxy, options } = await setup({ hostRequest: vi.fn(async (_scope, kind) => { if (kind === "fail") throw Object.assign(new Error("declined"), { code: "declined" }); return { approved: true }; }) });
    await proxy.send(scope, { version: 2, type: "subscribe_scope" });
    await until(() => daemon.received.length === 1 && daemon.sockets.length === 1);
    expect(options.connection).toHaveBeenCalledWith(scope, true);
    const ws = daemon.sockets[0]!;
    ws.send(JSON.stringify({ version: 2, type: "scope.summaries", scope_seq: 1, summaries: [] }));
    ws.send(JSON.stringify({ version: 2, type: "host.request", request_id: "h1", kind: "settings.confirm", payload: { operation: "x" } }));
    ws.send(JSON.stringify({ version: 2, type: "host.request", request_id: "h2", kind: "fail", payload: {} }));
    await until(() => daemon.received.length === 3);
    expect(options.message).toHaveBeenCalledWith(scope, expect.objectContaining({ type: "scope.summaries" }));
    expect(options.message).toHaveBeenCalledTimes(1);
    expect(options.hostRequest).toHaveBeenCalledWith(scope, "settings.confirm", { operation: "x" });
    expect(daemon.received.slice(1)).toEqual(expect.arrayContaining([
      { version: 2, type: "host.reply", request_id: "h1", result: { approved: true } },
      { version: 2, type: "host.reply", request_id: "h2", error: { kind: "declined", message: "declined" } },
    ]));
  });

  it("reconnects a dropped socket and tells the renderer to resubscribe", async () => {
    const { daemon, proxy, options } = await setup();
    await proxy.send(scope, { version: 2, type: "subscribe_scope" });
    await until(() => daemon.sockets.length === 1);
    daemon.sockets[0]!.terminate();
    await until(() => daemon.sockets.length === 2);
    await until(() => vi.mocked(options.connection).mock.calls.filter(([, up]) => up).length === 2);
    expect(options.connection).toHaveBeenCalledWith(scope, false);
  });
});
