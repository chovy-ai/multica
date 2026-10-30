// @vitest-environment node
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createPreviewProxy } from "./preview-proxy";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
async function fixture() {
  const received = vi.fn();
  const server = http.createServer((request, response) => {
    received(request.headers); response.setHeader("Content-Type", "text/event-stream"); response.flushHeaders();
    request.on("end", () => { response.write("data: first\n\n"); setTimeout(() => response.end(Buffer.alloc(6 << 20, 120)), 10); }); request.resume();
  }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const connect = vi.fn(async (_target, signal) => {
    const value = net.connect({ host: "127.0.0.1", port: address.port, signal }); await once(value, "connect"); return value;
  }); const proxy = await createPreviewProxy({ connect });
  cleanup.push(() => { proxy.close(); server.closeAllConnections(); server.close(); });
  return { proxy, connect, received, authorization: `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}` };
}
it("requires native proxy credentials and streams responses beyond the file API limit without forwarding credentials", async () => {
  const { proxy, connect, received, authorization } = await fixture();
  const get = (auth?: string) => new Promise<{ status: number; size: number; first: string }>((resolve, reject) => {
    const request = http.request(`http://${proxy.address}`, { path: "http://localhost:3000/events", headers: { Host: "localhost:3000", Origin: "http://localhost:3000", ...(auth ? { "Proxy-Authorization": auth } : {}) } }, (response) => {
      let size = 0, first = ""; response.on("data", (data: Buffer) => { if (!size) first = data.toString(); size += data.length; });
      response.on("end", () => resolve({ status: response.statusCode!, size, first })); response.on("error", reject);
    }); request.on("error", reject); request.end();
  });
  expect((await get()).status).toBe(407); expect(connect).not.toHaveBeenCalled();
  const result = await get(authorization); expect(result.status).toBe(200); expect(result.size).toBe((6 << 20) + 13); expect(result.first).toBe("data: first\n\n");
  expect(received).toHaveBeenCalledWith(expect.objectContaining({ host: "localhost:3000", origin: "http://localhost:3000" }));
  expect(received.mock.calls[0]![0]["proxy-authorization"]).toBeUndefined();
});
it("routes CONNECT to the same source identity without parsing or terminating TLS bytes", async () => {
  const server = net.createServer((socket) => socket.pipe(socket)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const connect = vi.fn(async (_target, signal) => { const socket = net.connect({ host: "127.0.0.1", port: address.port, signal }); await once(socket, "connect"); return socket; });
  const proxy = await createPreviewProxy({ connect }); const socket = net.connect({ host: "127.0.0.1", port: Number(proxy.address.split(":")[1]) });
  cleanup.push(() => { socket.destroy(); proxy.close(); server.close(); }); await once(socket, "connect");
  const response = once(socket, "data"); socket.write(`CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\nProxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n\r\n`);
  expect((await response)[0].toString()).toContain("200 Connection Established");
  const bytes = Buffer.from([22, 3, 1, 0, 5, 1, 2, 3, 4, 5]); const reply = once(socket, "data"); socket.write(bytes); expect((await reply)[0]).toEqual(bytes);
  expect(connect).toHaveBeenCalledWith({ host: "localhost", port: 443, url: "https://localhost:443/" }, expect.any(AbortSignal));
});
