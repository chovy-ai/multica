import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { pipeline } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { RawData } from "ws";
import type { BrowserNodeSessionMode } from "../core/types.ts";
import type {
  BrowserNodeLoopbackPreviewRoutingOptions,
  BrowserNodeLoopbackPreviewTarget
} from "./loopbackPreview.ts";
import type { BrowserNodeElectronLogger } from "./types.ts";

const defaultLoopbackPreviewCacheTtlMs = 30_000;
const loopbackHostPattern = /^(localhost|127(?:\.\d{1,3}){0,3})$/i;
// Order matters: bypass all, subtract loopback so local previews can proxy,
// then keep HTTPS/WSS direct because this proxy does not implement CONNECT.
const loopbackPreviewProxyBypassRules = "*;<-loopback>;https://*;wss://*";
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

interface CachedLoopbackPreviewTarget {
  expiresAt: number;
  target: BrowserNodeLoopbackPreviewTarget | null;
}

export interface BrowserNodePreviewSession {
  setProxy(input: {
    mode: "fixed_servers";
    proxyBypassRules: string;
    proxyRules: string;
  }): Promise<void>;
}

export interface BrowserNodeLoopbackPreviewProxy {
  configureSession(input: {
    profileId: string | null;
    sessionMode: BrowserNodeSessionMode;
    sessionPartition?: string | null;
  }): Promise<void>;
  dispose(): Promise<void>;
  addressForTesting(): string;
  serverForTesting(): Server;
}

export interface BrowserNodeLoopbackPreviewProxyInput {
  logger?: BrowserNodeElectronLogger;
  resolveSession: (input: {
    profileId: string | null;
    sessionMode: BrowserNodeSessionMode;
    sessionPartition?: string | null;
  }) => BrowserNodePreviewSession | Promise<BrowserNodePreviewSession>;
  routing: BrowserNodeLoopbackPreviewRoutingOptions;
}

export function createBrowserNodeLoopbackPreviewProxy({
  logger,
  resolveSession,
  routing
}: BrowserNodeLoopbackPreviewProxyInput): BrowserNodeLoopbackPreviewProxy {
  const configuredSessions = new WeakSet<BrowserNodePreviewSession>();
  const targetCache = new Map<string, CachedLoopbackPreviewTarget>();
  const downstreamWebSocketServer = new WebSocketServer({ noServer: true });
  let server: Server | null = null;
  let serverStartPromise: Promise<string> | null = null;

  const cacheTtlMs = routing.cacheTtlMs ?? defaultLoopbackPreviewCacheTtlMs;
  const fallback = routing.fallback ?? "direct";

  const pruneExpiredTargets = (now: number): void => {
    for (const [cacheKey, cachedTarget] of targetCache.entries()) {
      if (cachedTarget.expiresAt <= now) {
        targetCache.delete(cacheKey);
      }
    }
  };

  const start = async (): Promise<string> => {
    if (server?.listening) {
      return addressForTesting();
    }
    if (serverStartPromise) {
      return serverStartPromise;
    }

    serverStartPromise = new Promise<string>((resolve, reject) => {
      const nextServer = createServer((request, response) => {
        void handleRequest(request, response);
      });
      nextServer.on("upgrade", (request, socket, head) => {
        void handleUpgrade(request, socket as Socket, head);
      });

      const cleanup = (): void => {
        nextServer.removeListener("error", onError);
        nextServer.removeListener("listening", onListening);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onListening = (): void => {
        cleanup();
        server = nextServer;
        resolve(addressForTesting());
      };

      nextServer.once("error", onError);
      nextServer.once("listening", onListening);
      nextServer.listen(0, "127.0.0.1");
    }).finally(() => {
      serverStartPromise = null;
    });

    return serverStartPromise;
  };

  const resolveLoopbackTarget = async (
    originalUrl: URL
  ): Promise<BrowserNodeLoopbackPreviewTarget | null> => {
    const port = Number(originalUrl.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }

    const now = Date.now();
    pruneExpiredTargets(now);

    const cacheKey = originalUrl.toString();
    const cached = targetCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.target;
    }

    const nextTarget = await Promise.resolve(
      routing.resolver.resolveTarget({
        port,
        url: originalUrl.toString()
      })
    );

    const target = normalizeLoopbackPreviewTarget(nextTarget);
    targetCache.set(cacheKey, {
      expiresAt: now + Math.max(0, cacheTtlMs),
      target
    });
    return target;
  };

  const configureSession = async (input: {
    profileId: string | null;
    sessionMode: BrowserNodeSessionMode;
    sessionPartition?: string | null;
  }): Promise<void> => {
    const nextSession = await resolveSession(input);
    if (configuredSessions.has(nextSession)) {
      return;
    }
    const address = await start();
    await nextSession.setProxy({
      mode: "fixed_servers",
      proxyBypassRules: loopbackPreviewProxyBypassRules,
      proxyRules: `http=${address}`
    });
    configuredSessions.add(nextSession);
  };

  const dispose = async (): Promise<void> => {
    targetCache.clear();
    downstreamWebSocketServer.close();
    const activeServer = server;
    server = null;
    if (!activeServer || !activeServer.listening) {
      return;
    }
    await new Promise<void>((resolve) => {
      activeServer.close(() => resolve());
    });
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const originalUrl = resolveProxyRequestUrl(request);
    if (!originalUrl) {
      response.writeHead(400);
      response.end("invalid proxy request");
      return;
    }
    if (originalUrl.protocol !== "http:") {
      response.writeHead(400);
      response.end("unsupported proxy request");
      return;
    }

    const targetContext = await resolveTargetRequestContext(originalUrl);
    if (!targetContext.targetUrl) {
      response.writeHead(502);
      response.end("unable to resolve loopback preview target");
      return;
    }

    const headers = filterProxyHeaders(request.headers);
    headers.set("host", targetContext.targetUrl.host);

    const forward =
      targetContext.targetUrl.protocol === "https:"
        ? httpsRequest
        : httpRequest;
    const upstream = forward(
      targetContext.targetUrl,
      {
        headers: Object.fromEntries(headers.entries()),
        method: request.method
      },
      (upstreamResponse) => {
        const responseHeaders = filterProxyHeaders(upstreamResponse.headers);
        const location = responseHeaders.get("location");
        if (location && targetContext.loopbackTarget) {
          const rewritten = rewriteLoopbackLocation({
            location,
            originalUrl,
            targetUrl: targetContext.loopbackTarget.targetUrl
          });
          if (rewritten) {
            responseHeaders.set("location", rewritten);
          }
        }

        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          Object.fromEntries(responseHeaders.entries())
        );
        pipeline(upstreamResponse, response, () => undefined);
      }
    );

    upstream.on("error", (error) => {
      logger?.warn?.("Browser Node loopback preview request failed", {
        error: normalizeProxyError(error),
        originalUrl: originalUrl.toString(),
        targetUrl: targetContext.targetUrl?.toString() ?? null,
        workspaceId: targetContext.loopbackTarget?.workspaceId ?? null
      });
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end(
        `loopback preview upstream request failed: ${normalizeProxyError(error)}`
      );
    });

    pipeline(request, upstream, () => undefined);
  };

  const handleUpgrade = async (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer
  ): Promise<void> => {
    const originalUrl = resolveProxyRequestUrl(request, "ws:");
    if (!originalUrl) {
      socket.destroy();
      return;
    }
    if (originalUrl.protocol !== "ws:") {
      socket.destroy();
      return;
    }

    const targetContext = await resolveTargetRequestContext(originalUrl);
    const targetUrl = targetContext.targetUrl;
    if (!targetUrl) {
      socket.destroy();
      return;
    }

    downstreamWebSocketServer.handleUpgrade(
      request,
      socket,
      head,
      (downstream) => {
        const headers = Object.fromEntries(
          filterProxyHeaders(request.headers).entries()
        );
        headers.host = targetUrl.host;

        const upstream = new WebSocket(targetUrl, { headers });
        const pendingMessages: Array<{ data: RawData; isBinary: boolean }> = [];

        downstream.on("message", (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(data, { binary: isBinary });
            return;
          }
          pendingMessages.push({ data, isBinary });
        });

        upstream.once("open", () => {
          for (const nextMessage of pendingMessages.splice(0)) {
            upstream.send(nextMessage.data, { binary: nextMessage.isBinary });
          }
        });

        upstream.on("message", (data, isBinary) => {
          if (downstream.readyState === WebSocket.OPEN) {
            downstream.send(data, { binary: isBinary });
          }
        });

        upstream.once("close", (code, reason) => {
          if (
            downstream.readyState === WebSocket.OPEN ||
            downstream.readyState === WebSocket.CONNECTING
          ) {
            downstream.close(normalizeWebSocketCloseCode(code), reason);
          }
        });

        downstream.once("close", (code, reason) => {
          if (
            upstream.readyState === WebSocket.OPEN ||
            upstream.readyState === WebSocket.CONNECTING
          ) {
            upstream.close(normalizeWebSocketCloseCode(code), reason);
          }
        });

        upstream.once("error", (error) => {
          logger?.warn?.("Browser Node loopback preview websocket failed", {
            error: normalizeProxyError(error),
            originalUrl: originalUrl.toString(),
            targetUrl: targetContext.targetUrl?.toString() ?? null,
            workspaceId: targetContext.loopbackTarget?.workspaceId ?? null
          });
          downstream.close(1011, "loopback preview websocket upstream failed");
        });
      }
    );
  };

  const resolveTargetRequestContext = async (
    originalUrl: URL
  ): Promise<{
    loopbackTarget: BrowserNodeLoopbackPreviewTarget | null;
    targetUrl: URL | null;
  }> => {
    if (!isLoopbackUrl(originalUrl)) {
      return {
        loopbackTarget: null,
        targetUrl: null
      };
    }

    const loopbackTarget = await resolveLoopbackTarget(originalUrl);
    if (loopbackTarget) {
      return {
        loopbackTarget,
        targetUrl: buildTargetRequestUrl(loopbackTarget.targetUrl, originalUrl)
      };
    }

    if (fallback === "direct") {
      return {
        loopbackTarget: null,
        targetUrl: cloneUrl(originalUrl)
      };
    }

    return {
      loopbackTarget: null,
      targetUrl: null
    };
  };

  const addressForTesting = (): string => {
    const address = server?.address();
    if (!address || typeof address === "string") {
      throw new Error("Browser Node loopback preview proxy is not listening");
    }
    return `127.0.0.1:${address.port}`;
  };

  const serverForTesting = (): Server => {
    if (!server) {
      throw new Error("Browser Node loopback preview proxy is not started");
    }
    return server;
  };

  return {
    addressForTesting,
    configureSession,
    dispose,
    serverForTesting
  };
}

function normalizeLoopbackPreviewTarget(
  input: BrowserNodeLoopbackPreviewTarget | null | undefined
): BrowserNodeLoopbackPreviewTarget | null {
  if (!input) {
    return null;
  }
  const normalizedTargetUrl = input.targetUrl.trim();
  if (normalizedTargetUrl.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(normalizedTargetUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return {
      targetUrl: parsed.toString(),
      workspaceId: input.workspaceId
    };
  } catch {
    return null;
  }
}

function resolveProxyRequestUrl(
  request: IncomingMessage,
  defaultProtocol = "http:"
): URL | null {
  const rawUrl = request.url ?? "";
  try {
    if (/^[a-z][a-z\d+\-.]*:\/\//i.test(rawUrl)) {
      return new URL(rawUrl);
    }
    const host = request.headers.host;
    if (typeof host !== "string" || host.trim().length === 0) {
      return null;
    }
    const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
    return new URL(`${defaultProtocol}//${host}${path}`);
  } catch {
    return null;
  }
}

function filterProxyHeaders(input: Headers | IncomingHttpHeaders): Headers {
  const output = new Headers();
  const appendValue = (key: string, value: string): void => {
    if (hopByHopHeaders.has(key.toLowerCase())) {
      return;
    }
    output.append(key, value);
  };

  if (input instanceof Headers) {
    input.forEach((value, key) => {
      appendValue(key, value);
    });
    return output;
  }

  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const nextValue of value) {
        appendValue(key, nextValue);
      }
      continue;
    }
    if (typeof value === "string") {
      appendValue(key, value);
    }
  }
  return output;
}

function isLoopbackUrl(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "ws:") &&
    loopbackHostPattern.test(url.hostname) &&
    url.port.length > 0
  );
}

function buildTargetRequestUrl(
  targetUrl: string,
  originalUrl: URL
): URL | null {
  try {
    const base = new URL(targetUrl);
    const normalizedBasePath = normalizeBasePath(base.pathname);
    const nextUrl = new URL(base.toString());
    nextUrl.pathname = joinBasePath(normalizedBasePath, originalUrl.pathname);
    nextUrl.search = originalUrl.search;
    nextUrl.hash = "";
    if (originalUrl.protocol === "ws:") {
      nextUrl.protocol = nextUrl.protocol === "https:" ? "wss:" : "ws:";
    }
    return nextUrl;
  } catch {
    return null;
  }
}

function rewriteLoopbackLocation({
  location,
  originalUrl,
  targetUrl
}: {
  location: string;
  originalUrl: URL;
  targetUrl: string;
}): string | null {
  try {
    const targetBase = new URL(targetUrl);
    const resolvedLocation = new URL(location, targetBase);
    if (resolvedLocation.origin !== targetBase.origin) {
      return location;
    }

    const basePath = normalizeBasePath(targetBase.pathname);
    const strippedPath =
      stripBasePath(basePath, resolvedLocation.pathname) ??
      resolvedLocation.pathname;

    const loopbackUrl = new URL(originalUrl.origin);
    resolvedLocation.protocol = loopbackUrl.protocol;
    resolvedLocation.host = loopbackUrl.host;
    resolvedLocation.pathname = strippedPath;
    resolvedLocation.username = "";
    resolvedLocation.password = "";
    return resolvedLocation.toString();
  } catch {
    return location;
  }
}

function normalizeBasePath(pathname: string): string {
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function joinBasePath(basePath: string, requestPath: string): string {
  const normalizedRequestPath =
    requestPath === "/" ? "" : requestPath.replace(/^\/+/, "");
  return normalizedRequestPath.length > 0
    ? `${basePath}${normalizedRequestPath}`.replace(/\/{2,}/g, "/")
    : basePath;
}

function stripBasePath(basePath: string, pathname: string): string | null {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (normalizedPath === basePath.slice(0, -1)) {
    return "/";
  }
  if (!normalizedPath.startsWith(basePath)) {
    return null;
  }
  const suffix = normalizedPath.slice(basePath.length);
  return suffix.length > 0 ? `/${suffix}` : "/";
}

function cloneUrl(url: URL): URL | null {
  try {
    return new URL(url.toString());
  } catch {
    return null;
  }
}

function normalizeProxyError(error: unknown): string {
  if (error instanceof Error) {
    const code =
      typeof (error as NodeJS.ErrnoException).code === "string"
        ? ` ${(error as NodeJS.ErrnoException).code}`
        : "";
    return `${error.message}${code}`;
  }
  return String(error);
}

function normalizeWebSocketCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) {
    return code;
  }
  return 1000;
}
