import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

interface LoginAttempt {
  server: Server;
  timer?: ReturnType<typeof setTimeout>;
}

/** Dev instances receive browser auth directly instead of sharing an OS URL handler. */
export class DesktopBrowserLogin {
  private attempt: LoginAttempt | null = null;
  private opening: Promise<void> | null = null;

  constructor(private readonly options: {
    openBrowser: (url: string) => Promise<void> | void;
    onToken: (token: string) => void;
  }) {}

  start(appUrl: string): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.open(appUrl).finally(() => { this.opening = null; });
    return this.opening;
  }

  dispose(): void {
    const attempt = this.attempt;
    this.attempt = null;
    if (!attempt) return;
    clearTimeout(attempt.timer);
    attempt.server.close();
    attempt.server.closeIdleConnections();
  }

  private async open(appUrl: string): Promise<void> {
    const loginUrl = new URL("/login", appUrl);
    if (!["https:", "http:"].includes(loginUrl.protocol) || loginUrl.username || loginUrl.password) {
      throw new Error("Desktop browser login requires an HTTP or HTTPS web origin");
    }
    this.dispose();
    const state = randomBytes(32).toString("hex");
    const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
      if (this.attempt !== attempt) { reply(response, 410, "This sign-in attempt has ended."); return; }
      const address = server.address() as AddressInfo;
      if (request.headers.host !== `127.0.0.1:${address.port}`) { reply(response, 403, "Invalid callback host."); return; }
      if (request.method !== "GET") { reply(response, 405, "Use the browser sign-in callback."); return; }
      let url: URL;
      try { url = new URL(request.url ?? "/", `http://127.0.0.1:${address.port}`); }
      catch { reply(response, 400, "Invalid callback URL."); return; }
      if (url.pathname !== "/callback") { reply(response, 404, "Not found."); return; }
      const suppliedState = url.searchParams.get("state") ?? "";
      if (url.searchParams.getAll("state").length !== 1 || !/^[a-f0-9]{64}$/.test(suppliedState) || !timingSafeEqual(Buffer.from(suppliedState), Buffer.from(state))) {
        reply(response, 403, "This sign-in callback does not match the current attempt."); return;
      }
      const token = url.searchParams.get("token") ?? "";
      if (url.searchParams.getAll("token").length !== 1 || !token || token.length > 8192 || !/^[!-~]+$/.test(token)) {
        reply(response, 400, "A sign-in token is required."); return;
      }
      reply(response, 200, "Sign-in received. You can return to Multica.");
      this.dispose();
      this.options.onToken(token);
    });
    const attempt: LoginAttempt = { server };
    this.attempt = attempt;
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      if (this.attempt !== attempt) throw new Error("Desktop browser login was cancelled");
      const { port } = server.address() as AddressInfo;
      loginUrl.searchParams.set("platform", "desktop");
      loginUrl.searchParams.set("cli_callback", `http://127.0.0.1:${port}/callback`);
      loginUrl.searchParams.set("cli_state", state);
      attempt.timer = setTimeout(() => { if (this.attempt === attempt) this.dispose(); }, 10 * 60 * 1000);
      attempt.timer.unref();
      await this.options.openBrowser(loginUrl.href);
    } catch (error) {
      if (this.attempt === attempt) this.dispose();
      throw error;
    }
  }
}

function reply(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Multica sign-in</title><body><h1>Multica</h1><p>${message}</p></body></html>`);
}
