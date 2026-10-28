// @vitest-environment node
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { JsonRpcPeer } from "./json-rpc";
import { createSidecarHost, type SidecarHostBridge, type SidecarHostOptions } from "./sidecar-host";

const scope = { apiUrl: "https://api.example", userId: "user", workspaceId: "ws" };
const init = { instance: "i1", protocolVersion: 2, dataDir: "/data", profileDir: "/profile", cliPath: "/cli" };

function harness() {
  let bridge!: SidecarHostBridge;
  let busy = 0;
  const service = {
    request: vi.fn(async (_scope: unknown, method: string) => {
      if (method === "directory") return { path: await bridge.hostRequest("pick_directory", { current: "/" }) };
      if (method === "send") { busy = 1; bridge.notify(scope, "conv"); }
      return { method };
    }),
    setCurrentUser: vi.fn(), setDraining: vi.fn(), busyCount: () => busy, stop: vi.fn(async () => {}),
    resolveFile: vi.fn(async () => ({ path: "/data/f", mimeType: "text/plain", name: "f.txt" })),
    adoptFile: vi.fn(async () => "file-id"),
  };
  // The daemon side of the link: records notifications and answers host requests.
  const daemonIn = new PassThrough(), daemonOut = new PassThrough();
  const notifications: { method: string; params: unknown }[] = [];
  const hostRequests: unknown[] = [];
  const daemon = new JsonRpcPeer(daemonIn, daemonOut, async (method, params) => {
    if (method === "host.request") { hostRequests.push(params); return { path: "/picked" }; }
    notifications.push({ method, params });
    return undefined;
  });
  const shutdown = vi.fn();
  const host = createSidecarHost(() => sidecar, { createService: async (_input, b) => { bridge = b; return service as unknown as Awaited<ReturnType<NonNullable<SidecarHostOptions["createService"]>>>; }, onShutdown: shutdown });
  const sidecar: JsonRpcPeer = new JsonRpcPeer(daemonOut, daemonIn, (method, params) => host.handle(method, params));
  return { daemon, service, notifications, hostRequests, shutdown, close: () => { daemonIn.end(); daemonOut.end(); } };
}

const session = (connectionId: string) => ({ connectionId, userId: "user", apiUrl: scope.apiUrl, env: { MULTICA_TEST_ENV: connectionId } });

describe("sidecar host", () => {
  it("requires init and session before serving conversation requests", async () => {
    const h = harness();
    await expect(h.daemon.call("session.set", session("c1"))).rejects.toMatchObject({ data: { code: "not_initialized" } });
    await h.daemon.call("init", init);
    await expect(h.daemon.call("request", { connectionId: "c1", scope, method: "list", params: {} })).rejects.toMatchObject({ data: { code: "session_required" } });
    await h.daemon.call("session.set", session("c1"));
    expect(h.service.setCurrentUser).toHaveBeenCalledWith("user");
    expect(process.env.MULTICA_TEST_ENV).toBe("c1");
    expect(await h.daemon.call("request", { connectionId: "c1", scope, method: "list", params: {} })).toEqual({ method: "list" });
    await expect(h.daemon.call("session.set", { ...session("c1"), apiUrl: "https://other.example" })).rejects.toMatchObject({ data: { code: "api_url_mismatch" } });
    h.close();
  });

  it("sends human-facing requests to the connection that started the work", async () => {
    const h = harness();
    await h.daemon.call("init", init);
    await h.daemon.call("session.set", session("c1"));
    await h.daemon.call("session.set", session("c2"));
    expect(await h.daemon.call("request", { connectionId: "c1", scope, method: "directory", params: {} })).toEqual({ path: { path: "/picked" } });
    expect(h.hostRequests).toEqual([{ connectionId: "c1", kind: "pick_directory", payload: { current: "/" } }]);
    h.close();
  });

  it("numbers events, reports busy work and refuses new turns while draining", async () => {
    const h = harness();
    await h.daemon.call("init", init);
    await h.daemon.call("session.set", session("c1"));
    await h.daemon.call("request", { connectionId: "c1", scope, method: "send", params: {} });
    await vi.waitFor(() => expect(h.notifications.map((n) => n.method)).toEqual(expect.arrayContaining(["event", "busy"])));
    expect(h.notifications.find((n) => n.method === "event")?.params).toEqual({ seq: 1, event: { type: "changed", scope, sessionId: "conv" } });
    expect(h.notifications.find((n) => n.method === "busy")?.params).toEqual({ count: 1 });
    expect(await h.daemon.call("drain", {})).toEqual({ busy: 1 });
    expect(h.service.setDraining).toHaveBeenCalledWith(true);
    await expect(h.daemon.call("request", { connectionId: "c1", scope, method: "send", params: {} })).rejects.toMatchObject({ data: { code: "host_draining" } });
    expect(await h.daemon.call("request", { connectionId: "c1", scope, method: "read", params: {} })).toEqual({ method: "read" });
    await h.daemon.call("undrain", {});
    expect(h.service.setDraining).toHaveBeenLastCalledWith(false);
    h.close();
  });

  it("keeps cloud agent turns driven by the host", async () => {
    const h = harness();
    await h.daemon.call("init", init);
    await h.daemon.call("session.set", session("c1"));
    for (const method of ["remoteBegin", "remoteUpdate"]) {
      await expect(h.daemon.call("request", { connectionId: "c1", scope, method, params: {} })).rejects.toMatchObject({ data: { code: "method_not_allowed" } });
    }
    h.close();
  });

  it("resolves and adopts files without moving their bytes over the protocol", async () => {
    const h = harness();
    await h.daemon.call("init", init);
    await h.daemon.call("session.set", session("c1"));
    expect(await h.daemon.call("file.resolve", { scope, fileRef: "abc" })).toEqual({ path: "/data/f", mimeType: "text/plain", name: "f.txt" });
    expect(await h.daemon.call("file.commit", { scope, tempPath: "/data/uploads/u", name: "n.txt", mimeType: "text/plain", size: 3 })).toEqual({ id: "file-id" });
    expect(h.service.adoptFile).toHaveBeenCalledWith(scope, "/data/uploads/u", "n.txt", "text/plain");
    h.close();
  });

  it("persists before acknowledging shutdown", async () => {
    const h = harness();
    await h.daemon.call("init", init);
    await h.daemon.call("session.set", session("c1"));
    await h.daemon.call("shutdown", {});
    expect(h.service.stop).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.shutdown).toHaveBeenCalled());
    h.close();
  });
});
