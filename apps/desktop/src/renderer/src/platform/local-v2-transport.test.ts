// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { LocalV2Bridge } from "../../../shared/local-v2-bridge";
import { DirectLocalV2Transport } from "./local-v2-transport";

const scope = { userId: "user", workspaceId: "ws" };

interface Daemon { helloVersion?: number; server: Server; base: string; token: string; tickets: Set<string>; sockets: WebSocket[]; requests: IncomingMessage[]; received: unknown[]; close(): Promise<void> }

async function fakeDaemon(): Promise<Daemon> {
  const daemon = { token: "r1", tickets: new Set(), sockets: [], requests: [], received: [] } as unknown as Daemon;
  const wss = new WebSocketServer({ noServer: true });
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body)); };
  daemon.server = createServer((req, res) => {
    daemon.requests.push(req);
    if (req.headers.authorization !== `Bearer ${daemon.token}`) { res.writeHead(403).end("forbidden"); return; }
    if (req.url === "/local/v2/hello") { json(res, 200, { version: daemon.helloVersion ?? 2 }); return; }
    if (req.url === "/local/v2/ws-ticket") { const ticket = `ticket-${daemon.requests.length}`; daemon.tickets.add(ticket); json(res, 200, { ticket }); return; }
    if (req.url === "/local/v2/sessions/other/snapshot") { json(res, 403, { error: { kind: "account_mismatch", message: "another account" } }); return; }
    if (req.url === "/local/v2/sessions/missing/snapshot") { json(res, 404, { error: { kind: "not_found", message: "conversation missing" } }); return; }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => json(res, 200, { path: req.url, method: req.method, body: body ? JSON.parse(body) : null }));
  });
  daemon.server.on("upgrade", (req, socket, head) => {
    const ticket = new URL(req.url ?? "", "http://x").searchParams.get("ticket") ?? "";
    if (!daemon.tickets.delete(ticket)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
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

async function setup(hostRequest: LocalV2Bridge["hostRequest"] = vi.fn(async () => ({ ok: true }))) {
  const daemon = await fakeDaemon();
  let token = daemon.token, base = daemon.base;
  const bridge = { endpoint: vi.fn(async () => ({ base, apiUrl: "https://api.multica.ai", token, fileKey: "fk" })), choose: vi.fn(), hostRequest };
  const transport = new DirectLocalV2Transport({ bridge });
  cleanups.push(() => transport.release(scope), () => daemon.close());
  return { daemon, transport, bridge, rotate: (next: string) => { token = next; }, move: (next: string) => { base = next; } };
}

const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); expect(check()).toBe(true); };

describe("DirectLocalV2Transport", () => {
  it("reports availability from the hello probe and from each request", async () => {
    const { daemon, transport } = await setup();
    const availability = vi.fn();
    transport.onAvailability(availability);
    await transport.probe();
    expect(availability).toHaveBeenLastCalledWith({ state: "connected" });
    await expect(transport.request(scope, "GET", "/sessions/other/snapshot")).rejects.toThrow(/^account_mismatch: /);
    expect(availability).toHaveBeenLastCalledWith({ state: "unavailable", reason: "account_mismatch" });
    daemon.helloVersion = 3;
    await transport.probe();
    expect(availability).toHaveBeenLastCalledWith({ state: "unavailable", reason: "incompatible" });
    await transport.request(scope, "GET", "/sessions");
    expect(availability).toHaveBeenLastCalledWith({ state: "connected" });
    expect(transport.availability()).toEqual({ state: "connected" });
  });

  it("reports an unreachable daemon as offline", async () => {
    const { transport, move } = await setup();
    move("127.0.0.1:1");
    await transport.probe();
    expect(transport.availability()).toEqual({ state: "unavailable", reason: "daemon_offline" });
  });

  it("sends scoped requests with the renderer token and keeps the daemon's error kinds", async () => {
    const { daemon, transport } = await setup();
    expect(await transport.request(scope, "POST", "/sessions/c1/commands", { type: "send" })).toEqual({ path: "/local/v2/sessions/c1/commands", method: "POST", body: { type: "send" } });
    const headers = daemon.requests[0]!.headers;
    expect(headers.authorization).toBe("Bearer r1");
    expect(headers["x-multica-user-id"]).toBe("user");
    expect(headers["x-workspace-id"]).toBe("ws");
    expect(headers["x-multica-api-origin"]).toBe("https://api.multica.ai");
    await expect(transport.request(scope, "GET", "/sessions/missing/snapshot")).rejects.toThrow(/^not_found: conversation missing$/);
    await expect(transport.request(scope, "GET", "/../v1/hello")).rejects.toThrow(/^invalid_request: /);
  });

  it("re-reads rotated credentials once", async () => {
    const { daemon, transport, bridge, rotate } = await setup();
    await transport.request(scope, "GET", "/sessions");
    daemon.token = "r2"; rotate("r2");
    await transport.request(scope, "GET", "/sessions");
    expect(bridge.endpoint).toHaveBeenCalledTimes(2);
  });

  it("builds file URLs with the file key and the scope", async () => {
    const { daemon, transport } = await setup();
    expect(transport.fileUrl(scope, "/attachments/a1")).toBe("");
    await transport.request(scope, "GET", "/sessions");
    expect(transport.fileUrl(scope, "/attachments/a1")).toBe(`http://${daemon.base}/local/v2/attachments/a1?file_key=fk&api_origin=https%3A%2F%2Fapi.multica.ai&user_id=user&workspace_id=ws`);
    expect(transport.fileUrl(scope, "/preview/content?root=r&path=p")).toMatch(/\/preview\/content\?root=r&path=p&file_key=fk&/);
  });

  it("opens the WebSocket with a ticket, relays messages and answers host requests through main", async () => {
    const hostRequest = vi.fn(async (_scope: unknown, kind: string) => { if (kind === "fail") throw new Error("Error invoking remote method 'local-v2:host-request': Error: declined: The user declined"); return { approved: true }; });
    const { daemon, transport } = await setup(hostRequest);
    const messages = vi.fn(), connection = vi.fn();
    transport.subscribe(messages); transport.onConnection(connection);
    await transport.send(scope, { version: 2, type: "subscribe_scope", after_scope_seq: 0 });
    await until(() => daemon.received.length === 1 && daemon.sockets.length === 1);
    expect(connection).toHaveBeenCalledWith(scope, true);
    const ws = daemon.sockets[0]!;
    ws.send(JSON.stringify({ version: 2, type: "scope.summaries", scope_seq: 1, summaries: [] }));
    ws.send(JSON.stringify({ version: 2, type: "host.request", request_id: "h1", kind: "settings.confirm", payload: { operation: "x" } }));
    ws.send(JSON.stringify({ version: 2, type: "host.request", request_id: "h2", kind: "fail", payload: {} }));
    await until(() => daemon.received.length === 3);
    expect(messages).toHaveBeenCalledWith(scope, expect.objectContaining({ type: "scope.summaries" }));
    expect(messages).toHaveBeenCalledTimes(1);
    expect(hostRequest).toHaveBeenCalledWith(scope, "settings.confirm", { operation: "x" });
    expect(daemon.received.slice(1)).toEqual(expect.arrayContaining([
      { version: 2, type: "host.reply", request_id: "h1", result: { approved: true } },
      { version: 2, type: "host.reply", request_id: "h2", error: { kind: "declined", message: "The user declined" } },
    ]));
  });

  it("reconnects a dropped socket with a new ticket and reports the drop", async () => {
    const { daemon, transport } = await setup();
    const connection = vi.fn();
    transport.onConnection(connection);
    await transport.send(scope, { version: 2, type: "subscribe_scope", after_scope_seq: 0 });
    await until(() => daemon.sockets.length === 1);
    daemon.sockets[0]!.terminate();
    await until(() => daemon.sockets.length === 2);
    await until(() => connection.mock.calls.filter(([, up]) => up).length === 2);
    expect(connection).toHaveBeenCalledWith(scope, false);
  });
});
