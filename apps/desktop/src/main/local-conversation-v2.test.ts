// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalV2Client, LocalV2Error } from "./local-conversation-v2";

const scope = { userId: "user", workspaceId: "ws" };

interface Daemon { server: Server; base: string; token: string; requests: IncomingMessage[]; close(): Promise<void> }

async function fakeDaemon(): Promise<Daemon> {
  const daemon = { token: "t1", requests: [] } as unknown as Daemon;
  daemon.server = createServer((req, res) => {
    daemon.requests.push(req);
    if (req.headers.authorization !== `Bearer ${daemon.token}`) { res.writeHead(403).end(); return; }
    if (req.url === "/local/v2/drain") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ busy: 2 })); return; }
    if (req.url === "/local/v2/sessions/missing/snapshot") { res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { kind: "not_found", message: "conversation missing" } })); return; }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ path: req.url, method: req.method, body: body ? JSON.parse(body) : null })));
  });
  await new Promise<void>((resolve) => daemon.server.listen(0, "127.0.0.1", resolve));
  daemon.base = `127.0.0.1:${(daemon.server.address() as AddressInfo).port}`;
  daemon.close = () => new Promise<void>((resolve) => daemon.server.close(() => resolve()));
  return daemon;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup() {
  const daemon = await fakeDaemon();
  let token = daemon.token;
  const endpoint = vi.fn(async () => ({ base: daemon.base, token }));
  const client = new LocalV2Client({ apiUrl: "https://api.multica.ai", endpoint });
  cleanups.push(() => daemon.close());
  return { daemon, client, endpoint, rotate: (next: string) => { token = next; } };
}

describe("LocalV2Client", () => {
  it("gives the renderer derived credentials, never the profile token", async () => {
    const { daemon, client } = await setup();
    // The daemon derives the same values; see TestV2RendererCredentialsMatchDesktop.
    await expect(client.rendererEndpoint()).resolves.toEqual({
      base: daemon.base, apiUrl: "https://api.multica.ai",
      token: "a3bbe791d1c50e8cd0afe1d4872f001ce6d986f07404c22d9254a3f2c0de8331",
      fileKey: "64bde9d6264771573838ef0ad3a2d3a1f80f25f6a9fda3220160d0e854cdd843",
    });
  });

  it("sends scoped, authenticated requests and keeps the daemon's error kinds", async () => {
    const { daemon, client } = await setup();
    expect(await client.request(scope, "POST", "/folder-projects", { path: "/repo" })).toEqual({ path: "/local/v2/folder-projects", method: "POST", body: { path: "/repo" } });
    const headers = daemon.requests[0]!.headers;
    expect(headers["x-multica-user-id"]).toBe("user");
    expect(headers["x-workspace-id"]).toBe("ws");
    expect(headers["x-multica-api-origin"]).toBe("https://api.multica.ai");
    await expect(client.request(scope, "GET", "/sessions/missing/snapshot")).rejects.toMatchObject({ kind: "not_found", status: 404 });
    await expect(client.request(scope, "GET", "/../v1/hello")).rejects.toBeInstanceOf(LocalV2Error);
    expect(await client.drain()).toBe(2);
  });

  it("re-reads a rotated token once", async () => {
    const { daemon, client, endpoint, rotate } = await setup();
    await client.request(scope, "GET", "/sessions");
    daemon.token = "t2"; rotate("t2");
    await client.request(scope, "GET", "/sessions");
    expect(endpoint).toHaveBeenCalledTimes(2);
  });
});
