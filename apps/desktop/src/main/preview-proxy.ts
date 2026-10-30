import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";

export interface PreviewDialTarget { host: string; port: number; url: string }
export interface PreviewProxyOptions {
  connect(target: PreviewDialTarget, signal: AbortSignal): Promise<Duplex>;
  onError?(error: Error): void;
}

const cleanHeaders = (headers: http.IncomingHttpHeaders, upgrade = false) => {
  const next = { ...headers };
  for (const key of ["proxy-authorization", "proxy-connection", "keep-alive", "te", "trailer", "transfer-encoding", ...String(headers.connection ?? "").toLowerCase().split(/\s*,\s*/)]) {
    if (upgrade && key === "upgrade") continue;
    delete next[key];
  }
  if (!upgrade) { delete next.connection; delete next.upgrade; }
  return next;
};

/** An authenticated loopback HTTP proxy. Destination ownership is decided by connect. */
export async function createPreviewProxy(options: PreviewProxyOptions) {
  const password = randomBytes(32).toString("hex");
  const credential = Buffer.from(`Basic ${Buffer.from(`multica:${password}`).toString("base64")}`);
  const sockets = new Set<Duplex>();
  const pending = new Set<AbortController>();
  const authorized = (request: http.IncomingMessage) => {
    const actual = Buffer.from(request.headers["proxy-authorization"] ?? "");
    return actual.length === credential.length && timingSafeEqual(actual, credential);
  };
  const authResponse = "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Multica preview\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
  const dial = async (target: PreviewDialTarget, incoming: Duplex) => {
    const controller = new AbortController(); pending.add(controller);
    const cancel = () => controller.abort();
    incoming.once("close", cancel);
    const timer = setTimeout(cancel, 20_000); timer.unref();
    try {
      const socket = await options.connect(target, controller.signal);
      if (controller.signal.aborted || incoming.destroyed) { socket.destroy(); throw new Error("Preview connection canceled"); }
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      return socket;
    } finally { clearTimeout(timer); pending.delete(controller); incoming.removeListener("close", cancel); }
  };
  const target = (value: string) => {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password) throw new Error("Invalid proxy destination");
    const port = Number(url.port || 80);
    if (port < 1 || port > 65535) throw new Error("Invalid proxy port");
    return { url, dial: { host: url.hostname.replace(/^\[|\]$/g, ""), port, url: url.href } };
  };
  const report = (error: unknown) => { const value = error instanceof Error ? error : new Error("Preview connection failed"); options.onError?.(value); return value; };
  const server = http.createServer(async (request, response) => {
    if (!authorized(request)) { response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Multica preview"', Connection: "close" }); response.end(); return; }
    let outgoing: http.ClientRequest | undefined;
    try {
      const parsed = target(request.url ?? "");
      const upstream = await dial(parsed.dial, request.socket);
      if (response.destroyed) { upstream.destroy(); return; }
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => upstream;
      outgoing = http.request({ hostname: parsed.dial.host, port: parsed.dial.port, path: parsed.url.pathname + parsed.url.search, method: request.method, headers: cleanHeaders(request.headers), agent }, (reply) => {
        response.writeHead(reply.statusCode ?? 502, cleanHeaders(reply.headers)); response.flushHeaders(); reply.pipe(response);
        reply.on("error", () => response.destroy());
      });
      response.once("close", () => { outgoing?.destroy(); upstream.destroy(); agent.destroy(); });
      outgoing.on("error", (error) => { report(error); if (!response.headersSent) response.writeHead(502); response.end("Preview service is unavailable"); });
      request.pipe(outgoing);
    } catch (error) { report(error); if (!response.headersSent) response.writeHead(502); response.end("Preview service is unavailable"); }
  });
  const tunnel = async (request: http.IncomingMessage, socket: Duplex, head: Buffer, upgrade: boolean) => {
    if (!authorized(request)) { socket.end(authResponse); return; }
    try {
      const parsed = target(upgrade ? request.url ?? "" : `http://${request.url}`);
      if (!upgrade && (parsed.url.pathname !== "/" || parsed.url.search || parsed.url.hash)) throw new Error("Invalid CONNECT authority");
      const upstream = await dial({ ...parsed.dial, url: upgrade ? parsed.dial.url : `https://${parsed.url.host}/` }, socket);
      if (upgrade) {
        const headers = cleanHeaders(request.headers, true); headers.connection = "Upgrade";
        upstream.write(`${request.method} ${parsed.url.pathname}${parsed.url.search} HTTP/1.1\r\n${Object.entries(headers).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("\r\n")}\r\n\r\n`);
      } else socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
      socket.once("close", () => upstream.destroy()); upstream.once("close", () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    } catch (error) { report(error); socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); }
  };
  server.on("connect", (request, socket, head) => { void tunnel(request, socket, head, false); });
  server.on("upgrade", (request, socket, head) => { void tunnel(request, socket, head, true); });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview proxy failed to listen");
  return { address: `127.0.0.1:${address.port}`, username: "multica", password,
    close() { for (const controller of pending) controller.abort(); for (const socket of sockets) socket.destroy(); server.close(); },
  };
}
