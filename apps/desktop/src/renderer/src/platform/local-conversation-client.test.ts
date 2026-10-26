import { describe, expect, it, vi } from "vitest";
import { LOCAL_CONVERSATION_METHODS, LOCAL_CONVERSATION_PROTOCOL_VERSION, type LocalConversationClient } from "@multica/tutti-agent-gui-host/local-protocol";
import { getLocalConversationClient, LocalRuntimeUpdateRequired } from "./local-conversation-client";

const scope = { userId: "reader", workspaceId: "workspace" };
const capabilities = { protocolVersion: LOCAL_CONVERSATION_PROTOCOL_VERSION, methods: Object.keys(LOCAL_CONVERSATION_METHODS) };
function setup(response: unknown = capabilities) {
  const request = vi.fn(async (_scope, method) => method === "capabilities" ? response : []);
  const raw = { request, subscribe: () => () => {} } as LocalConversationClient;
  return { raw, request, client: getLocalConversationClient(raw) };
}
describe("desktop runtime capability checks", () => {
  it("shares one check across concurrent requests and keeps workspace boundaries", async () => {
    const { raw, client, request } = setup();
    expect(getLocalConversationClient(raw)).toBe(client);
    expect(getLocalConversationClient(client)).toBe(client);
    await Promise.all([client.request(scope, "list", {}), client.request(scope, "providers", {})]);
    expect(request.mock.calls.filter(([, method]) => method === "capabilities")).toHaveLength(1);
    await client.request({ ...scope, workspaceId: "other" }, "list", {});
    expect(request.mock.calls.filter(([, method]) => method === "capabilities")).toHaveLength(2);
    expect(client.needsRestart(scope)).toBe(false);
  });
  it("blocks an unadvertised operation before dispatch while allowing supported history reads", async () => {
    const { client, request } = setup({ ...capabilities, methods: ["capabilities", "read"] });
    await expect(client.request(scope, "send", { id: "session", content: "Never submit" })).rejects.toBeInstanceOf(LocalRuntimeUpdateRequired);
    await expect(client.request(scope, "read", { id: "session" })).resolves.toEqual([]);
    expect(request.mock.calls.some(([, method]) => method === "send")).toBe(false);
    expect(client.needsRestart(scope)).toBe(true);
  });
  it("retains legacy history without loading attachment bytes or retrying mutations", async () => {
    const { client, request } = setup();
    request.mockImplementation(async (_scope, method) => {
      if (method === "capabilities" || method === "fileInfo" || method === "queueEnqueue") throw new Error("Error invoking remote method 'local-conversation:request': Error: Unknown local conversation request");
      return [];
    });
    const listener = vi.fn(); const unsubscribe = client.subscribeCompatibility(listener);
    await expect(client.request(scope, "list", {})).resolves.toEqual([]);
    await expect(client.request(scope, "fileInfo", { id: "attachment" })).rejects.toBeInstanceOf(LocalRuntimeUpdateRequired);
    await expect(client.request(scope, "queueEnqueue", {} as never)).rejects.toBeInstanceOf(LocalRuntimeUpdateRequired);
    expect(request.mock.calls.map(([, method]) => method)).toEqual(["capabilities", "list", "fileInfo", "queueEnqueue"]);
    expect(listener).toHaveBeenCalledOnce(); unsubscribe();
  });
  it.each([null, {}, { protocolVersion: 1, methods: "send" }, { ...capabilities, protocolVersion: 2 }])("rejects an incompatible or malformed handshake: %j", async (response) => {
    const { client, request } = setup(response);
    await expect(client.request(scope, "send", { id: "session", content: "Never submit" })).rejects.toBeInstanceOf(LocalRuntimeUpdateRequired);
    expect(request).toHaveBeenCalledOnce();
    expect(client.needsRestart(scope)).toBe(true);
  });
  it("preserves authentication errors and retries a failed check instead of caching it forever", async () => {
    const { client, request } = setup(); const denied = new Error("Local account changed");
    request.mockRejectedValueOnce(denied);
    await expect(client.request(scope, "list", {})).rejects.toBe(denied);
    expect(client.needsRestart(scope)).toBe(false);
    await expect(client.request(scope, "list", {})).resolves.toEqual([]);
    expect(request.mock.calls.filter(([, method]) => method === "capabilities")).toHaveLength(2);
  });
  it("does not classify an execution or file error as a version mismatch", async () => {
    const { client, request } = setup(); const missing = new Error("ENOENT: missing attachment");
    await client.check(scope); request.mockRejectedValueOnce(missing);
    await expect(client.request(scope, "fileInfo", { id: "file" })).rejects.toBe(missing);
    expect(client.needsRestart(scope)).toBe(false);
  });
});
