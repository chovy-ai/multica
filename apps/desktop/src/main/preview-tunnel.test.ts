// @vitest-environment node
import http from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { openPreviewTunnel } from "./preview-tunnel";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
async function server() {
  const server = http.createServer(), ws = new WebSocketServer({ server });
  cleanup.push(() => { for (const client of ws.clients) client.terminate(); ws.close(); server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return { ws, url: `ws://127.0.0.1:${address.port}/local/preview/tunnel` };
}
it("streams large payloads in bounded binary frames and preserves both TCP half closes", async () => {
  const fixture = await server(); let bytes = 0, frames = 0, credential = "";
  fixture.ws.on("connection", (ws, request) => {
    credential = request.headers.authorization ?? "";
    ws.on("message", (raw, binary) => {
      if (binary) { const size = Array.isArray(raw) ? raw.reduce((size, chunk) => size + chunk.length, 0) : raw.byteLength; bytes += size; frames++; expect(size).toBeLessThanOrEqual(64 << 10); }
      else { expect(raw.toString()).toBe('{"type":"half_close"}'); ws.send(Buffer.from(`received:${bytes}`)); ws.send('{"type":"half_close"}'); }
    });
  });
  const stream = await openPreviewTunnel(fixture.url, { Authorization: "Bearer fixture-main-token" }, new AbortController().signal);
  const replies: Buffer[] = []; stream.on("data", (chunk) => replies.push(chunk));
  const ended = once(stream, "end"); stream.end(Buffer.alloc(6 << 20, 1)); await ended;
  expect(bytes).toBe(6 << 20); expect(frames).toBe(96); expect(credential).toBe("Bearer fixture-main-token");
  expect(Buffer.concat(replies).toString()).toBe(`received:${6 << 20}`); stream.destroy();
});
it("reports an unexpected disconnect instead of a clean EOF", async () => {
  const fixture = await server(); fixture.ws.on("connection", (ws) => setTimeout(() => ws.terminate(), 10));
  const stream = await openPreviewTunnel(fixture.url, {}, new AbortController().signal);
  const [error] = await once(stream, "error"); expect(error.message).toContain("device_unreachable");
});
it("cancels an unfinished local bridge handshake", async () => {
  const fixture = await server(); fixture.ws.options.verifyClient = () => {};
  const controller = new AbortController(); const pending = openPreviewTunnel(fixture.url, {}, controller.signal);
  const failure = expect(pending).rejects.toThrow(); controller.abort(); await failure;
});
