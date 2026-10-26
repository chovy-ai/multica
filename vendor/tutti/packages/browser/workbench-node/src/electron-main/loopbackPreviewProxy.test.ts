import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server
} from "node:http";
import test from "node:test";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { createBrowserNodeLoopbackPreviewProxy } from "./loopbackPreviewProxy.ts";

function serverPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  return address.port;
}

function rawWebSocketMessageToString(message: RawData): string {
  if (Buffer.isBuffer(message)) {
    return message.toString();
  }
  if (Array.isArray(message)) {
    return Buffer.concat(message).toString();
  }
  return Buffer.from(message).toString();
}

async function listen(server: Server): Promise<void> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  server.close();
  await once(server, "close");
}

function requestThroughProxy(input: {
  body?: string;
  host: string;
  method?: string;
  path: string;
  proxyAddress: string;
}): Promise<{
  body: string;
  headers: IncomingHttpHeaders;
  statusCode: number;
}> {
  const [hostname, port] = input.proxyAddress.split(":");
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: {
          Host: input.host
        },
        hostname,
        method: input.method ?? "GET",
        path: input.path,
        port: Number(port)
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({
            body: responseBody,
            headers: response.headers,
            statusCode: response.statusCode ?? 0
          });
        });
      }
    );
    request.once("error", reject);
    request.end(input.body ?? "");
  });
}

test("configures a Browser Node session proxy only once per session", async () => {
  const session = {
    setProxyCalls: [] as Array<Record<string, string>>,
    async setProxy(input: Record<string, string>): Promise<void> {
      this.setProxyCalls.push(input);
    }
  };

  const proxy = createBrowserNodeLoopbackPreviewProxy({
    resolveSession: () => session,
    routing: {
      resolver: {
        resolveTarget: () => null
      }
    }
  });

  await proxy.configureSession({
    profileId: null,
    sessionMode: "shared"
  });
  await proxy.configureSession({
    profileId: null,
    sessionMode: "shared"
  });

  assert.equal(session.setProxyCalls.length, 1);
  assert.match(
    session.setProxyCalls[0]?.proxyRules ?? "",
    /^http=127\.0\.0\.1:\d+$/
  );
  assert.equal(
    session.setProxyCalls[0]?.proxyBypassRules,
    "*;<-loopback>;https://*;wss://*"
  );

  await proxy.dispose();
});

test("rejects HTTPS proxy requests instead of partially proxying them", async (t) => {
  let resolverCalls = 0;
  const proxy = createBrowserNodeLoopbackPreviewProxy({
    resolveSession: () => ({
      setProxy: async () => undefined
    }),
    routing: {
      resolver: {
        resolveTarget: () => {
          resolverCalls += 1;
          return { targetUrl: "http://127.0.0.1:9999/" };
        }
      }
    }
  });
  await proxy.configureSession({
    profileId: null,
    sessionMode: "shared"
  });
  t.after(async () => {
    await proxy.dispose();
  });

  const response = await requestThroughProxy({
    host: "example.com",
    path: "https://example.com/docs",
    proxyAddress: proxy.addressForTesting()
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body, "unsupported proxy request");
  assert.equal(resolverCalls, 0);
});

test("does not forward non-loopback HTTP requests if they reach the proxy", async (t) => {
  let resolverCalls = 0;
  const proxy = createBrowserNodeLoopbackPreviewProxy({
    resolveSession: () => ({
      setProxy: async () => undefined
    }),
    routing: {
      resolver: {
        resolveTarget: () => {
          resolverCalls += 1;
          return { targetUrl: "http://127.0.0.1:9999/" };
        }
      }
    }
  });
  await proxy.configureSession({
    profileId: null,
    sessionMode: "shared"
  });
  t.after(async () => {
    await proxy.dispose();
  });

  const response = await requestThroughProxy({
    host: "example.com",
    path: "/docs",
    proxyAddress: proxy.addressForTesting()
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body, "unable to resolve loopback preview target");
  assert.equal(resolverCalls, 0);
});

test("proxies loopback HTTP requests and rewrites Location headers", async (t) => {
  const upstream = createServer((request, response) => {
    response.writeHead(201, {
      Location: "/login?next=%2Fdocs",
      "X-Upstream-Path": request.url ?? ""
    });
    response.end(`${request.method} ${request.url}`);
  });
  await listen(upstream);
  t.after(async () => {
    await closeServer(upstream);
  });

  const proxy = createBrowserNodeLoopbackPreviewProxy({
    resolveSession: () => ({
      setProxy: async () => undefined
    }),
    routing: {
      resolver: {
        resolveTarget: () => ({
          targetUrl: `http://127.0.0.1:${serverPort(upstream)}/preview/`
        })
      }
    }
  });
  await proxy.configureSession({
    profileId: null,
    sessionMode: "shared"
  });
  t.after(async () => {
    await proxy.dispose();
  });

  const response = await requestThroughProxy({
    host: "127.0.0.1:5173",
    method: "POST",
    path: "/docs/index.html?tab=1",
    proxyAddress: proxy.addressForTesting()
  });

  assert.equal(response.statusCode, 201);
  assert.equal(
    response.headers["x-upstream-path"],
    "/preview/docs/index.html?tab=1"
  );
  assert.equal(
    response.headers.location,
    "http://127.0.0.1:5173/login?next=%2Fdocs"
  );
  assert.equal(response.body, "POST /preview/docs/index.html?tab=1");
});

test("caches loopback preview targets by full URL instead of port only", async () => {
  const resolverCalls: string[] = [];
  const session = {
    async setProxy(): Promise<void> {
      return undefined;
    }
  };

  const proxy = createBrowserNodeLoopbackPreviewProxy({
    resolveSession: () => session,
    routing: {
      resolver: {
        resolveTarget: ({ url }) => {
          resolverCalls.push(url);
          return { targetUrl: "http://127.0.0.1:9999/" };
        }
      }
    }
  });

  await proxy.configureSession({
    profileId: null,
    sessionMode: "shared"
  });

  await Promise.all([
    requestThroughProxy({
      host: "127.0.0.1:5173",
      path: "/first",
      proxyAddress: proxy.addressForTesting()
    }).catch(() => undefined),
    requestThroughProxy({
      host: "127.0.0.1:5173",
      path: "/second",
      proxyAddress: proxy.addressForTesting()
    }).catch(() => undefined)
  ]);

  assert.equal(resolverCalls.length, 2);
  assert.notEqual(resolverCalls[0], resolverCalls[1]);

  await proxy.dispose();
});

test("proxies loopback WebSocket upgrades", async (t) => {
  const upstreamServer = createServer();
  const upstreamSockets = new WebSocketServer({ server: upstreamServer });
  upstreamSockets.on("connection", (socket, request) => {
    socket.send(`path:${request.url ?? ""}`);
    socket.on("message", (message) => {
      socket.send(`echo:${rawWebSocketMessageToString(message)}`);
    });
  });
  await listen(upstreamServer);
  t.after(async () => {
    await new Promise<void>((resolve) => {
      upstreamSockets.close(() => resolve());
    });
    await closeServer(upstreamServer);
  });

  const proxy = createBrowserNodeLoopbackPreviewProxy({
    resolveSession: () => ({
      setProxy: async () => undefined
    }),
    routing: {
      resolver: {
        resolveTarget: () => ({
          targetUrl: `http://127.0.0.1:${serverPort(upstreamServer)}/preview/`
        })
      }
    }
  });
  await proxy.configureSession({
    profileId: null,
    sessionMode: "shared"
  });
  t.after(async () => {
    await proxy.dispose();
  });

  const client = new WebSocket(
    `ws://${proxy.addressForTesting()}/socket?room=1`,
    {
      headers: {
        Host: "127.0.0.1:5173"
      }
    }
  );
  t.after(async () => {
    if (client.readyState === WebSocket.CLOSED) {
      return;
    }
    client.close();
    await once(client, "close");
  });

  await once(client, "open");
  const [pathMessage] = (await once(client, "message")) as [Buffer];
  assert.equal(pathMessage.toString(), "path:/preview/socket?room=1");

  client.send("hello");
  const [echoMessage] = (await once(client, "message")) as [Buffer];
  assert.equal(echoMessage.toString(), "echo:hello");
  client.close();
  await once(client, "close");
});
