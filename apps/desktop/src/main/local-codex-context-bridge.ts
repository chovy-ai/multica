import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

/** Keeps per-turn MCP credentials out of persistent thread config and shared process state. */
export class CodexContextBridge {
  readonly token = randomBytes(32).toString("hex");
  private routes = new Map<string, { url: string; token: string; signal: AbortSignal }>();
  private server = createServer(async (request, response) => {
    const supplied = request.headers.authorization ?? "";
    const expected = `Bearer ${this.token}`;
    const target = this.routes.get(request.url ?? "");
    if (request.headers.origin || request.headers.host !== this.host || !target
      || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { response.writeHead(403).end(); return; }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 1_048_576) { response.writeHead(413).end(); return; }
        chunks.push(bytes);
      }
      const result = await fetch(target.url, { method: "POST", redirect: "error", signal: target.signal,
        headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          ...(request.headers["mcp-protocol-version"] ? { "MCP-Protocol-Version": String(request.headers["mcp-protocol-version"]) } : {}),
        },
        body: Buffer.concat(chunks),
      });
      response.writeHead(result.status, { "Content-Type": result.headers.get("content-type") ?? "application/json" });
      if (result.body) for await (const chunk of result.body) {
        if (response.destroyed) break;
        response.write(chunk);
      }
      response.end();
    } catch { if (!response.headersSent) response.writeHead(503); response.end(); }
  });
  private host = "";
  private ready?: Promise<void>;
  constructor() { this.server.requestTimeout = 30_000; this.server.headersTimeout = 5000; }
  start(): Promise<void> {
    return this.ready ??= new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (!address || typeof address === "string") { reject(new Error("Could not start Codex context bridge")); return; }
        this.host = `127.0.0.1:${address.port}`; resolve();
      });
    });
  }
  bind(id: string, target: { url: string; token: string; signal: AbortSignal }): string {
    const path = `/mcp/${id}`; this.routes.set(path, target); return `http://${this.host}${path}`;
  }
  release(id: string): void { this.routes.delete(`/mcp/${id}`); }
  async stop(): Promise<void> {
    if (!this.ready) return;
    await this.ready.catch(() => {}); this.routes.clear(); this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
