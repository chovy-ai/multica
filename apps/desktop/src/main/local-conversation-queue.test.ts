// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalConversationService } from "./local-conversation-service";
import type { LocalQueuedPrompt } from "@multica/tutti-agent-gui-host/local-protocol";
import type { runLocalProvider } from "./local-provider-runner";

const scope = { userId: "queue-user", workspaceId: "queue-workspace" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function prompt(requestId: string, content = requestId): LocalQueuedPrompt {
  return { requestId, content, display: { id: requestId, clientSubmitId: requestId, content: [{ type: "text", text: content }], createdAtUnixMs: 1 } };
}
async function setup(run: typeof runLocalProvider) {
  const root = await mkdtemp(join(tmpdir(), "multica-main-queue-"));
  const options = { root, apiUrl: "https://queue.test", notify: vi.fn(), chooseDirectory: async () => null, run: vi.fn(run), find: async () => "/test-owned/fake-cli" };
  const service = new LocalConversationService(options); service.setCurrentUser(scope.userId);
  cleanup.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { service, options };
}
describe("Electron-owned conversation queue", () => {
  it.each(["codex", "claude"] as const)("restores large file and image references before %s dispatch without embedding bytes", async (provider) => {
    const { service, options } = await setup(async () => ({ output: "done" }));
    const entry = await service.request(scope, "create", { provider });
    const files = await Promise.all([
      service.request(scope, "fileStore", { name: "cases.pos", mimeType: "application/octet-stream", data: Buffer.alloc(7_600_000, 65).toString("base64") }),
      service.request(scope, "fileStore", { name: "pasted image", mimeType: "image/png", data: Buffer.from("test pixels").toString("base64") }),
    ]);
    const metadata = await Promise.all(files.map((file) => service.request(scope, "fileInfo", file)));
    expect(metadata[0]?.path.endsWith(".pos")).toBe(true);
    expect(metadata[1]?.path.endsWith(".png")).toBe(true);
    const item = { ...prompt("persisted-files", "Read the local files"), attachmentIds: files.map((file) => file.id) };
    await service.request(scope, "queueEnqueue", { id: entry.id, item, paused: true });
    await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId); cleanup.unshift(() => reopened.stop());
    const restored = await reopened.request(scope, "read", { id: entry.id });
    expect(restored.promptQueue?.items[0]?.attachmentIds).toEqual(item.attachmentIds);
    expect(JSON.stringify(restored).length).toBeLessThan(10000);
    const requests = vi.spyOn(reopened, "request");
    await reopened.request(scope, "queueUpdate", { id: entry.id, action: "resume" });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
    const input = options.run.mock.calls[0]![0];
    for (const file of metadata) expect(input.content).toContain(file.path);
    expect(input.content.length).toBeLessThan(5000);
    expect(input).not.toHaveProperty("images");
    expect(requests.mock.calls.some(([, method]) => method === "fileRead")).toBe(false);
  });
  it.each(["codex", "claude"] as const)("identifies the dispatching %s prompt without hiding a waiting successor", async (provider) => {
    let allowAdmission!: () => void;
    let finish!: () => void;
    const admission = new Promise<void>((resolve) => { allowAdmission = resolve; });
    const running = new Promise<void>((resolve) => { finish = resolve; });
    const { service, options } = await setup(async () => { await running; return { output: "done" }; });
    const entry = await service.request(scope, "create", { provider });
    options.find = async () => { await admission; return "/test-owned/fake-cli"; };
    try {
      const receipt = await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("first") });
      expect(receipt).toMatchObject({ dispatchingRequestId: "first" });
      expect((await service.request(scope, "read", { id: entry.id })).promptQueue).toMatchObject({ dispatchingRequestId: "first" });
      expect((await service.request(scope, "list", {})).find((value) => value.id === entry.id)?.promptQueue).toMatchObject({ dispatchingRequestId: "first" });
      allowAdmission();
      await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
      await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).promptQueue?.items).toEqual([]));
      const waiting = await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("second") });
      expect(waiting.items.map((item) => item.requestId)).toEqual(["second"]);
      expect(waiting).not.toHaveProperty("dispatchingRequestId");
    } finally { allowAdmission(); finish(); }
  });
  it.each(["codex", "claude"] as const)("continues %s without a renderer, serializes admission and deduplicates a remounted view", async (provider) => {
    let finish!: () => void;
    const first = new Promise<void>((resolve) => { finish = resolve; });
    const { service, options } = await setup(async (input) => { if (input.content === "first") await first; return { output: input.content, sessionId: "saved-native" }; });
    const entry = await service.request(scope, "create", { provider });
    await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("first") });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledTimes(1));
    const file = await service.request(scope, "fileStore", { name: "pasted.png", mimeType: "image/png", data: Buffer.from("fake image").toString("base64") });
    const second = { ...prompt("second"), attachmentIds: [file.id], model: "saved-model", permissionMode: "auto" as const };
    await Promise.all([service.request(scope, "queueEnqueue", { id: entry.id, item: second }), service.request(scope, "queueEnqueue", { id: entry.id, item: second })]);
    expect((await service.request(scope, "read", { id: entry.id })).promptQueue?.items).toHaveLength(1);
    // No GUI, subscription or further IPC request is needed to release work.
    options.notify.mockClear(); finish();
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns.at(-1)?.status).toBe("completed"));
    expect(options.run.mock.calls[1]?.[0]).toMatchObject({ resume: "saved-native", model: "saved-model", permissionMode: "auto", content: expect.stringContaining("image viewing tool") });
    await service.request(scope, "queueEnqueue", { id: entry.id, item: second });
    expect(options.run).toHaveBeenCalledTimes(2);
  });
  it("persists manual pause and resumes only when explicitly requested", async () => {
    const { service, options } = await setup(async () => ({ output: "done" }));
    const entry = await service.request(scope, "create", { provider: "codex" });
    await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("saved"), paused: true });
    await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId); cleanup.unshift(() => reopened.stop());
    expect((await reopened.request(scope, "read", { id: entry.id })).promptQueue).toMatchObject({ paused: true, items: [{ requestId: "saved" }] });
    expect(options.run).not.toHaveBeenCalled();
    await reopened.request(scope, "queueUpdate", { id: entry.id, action: "resume" });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
  });
  it("pauses after a provider failure and keeps the following message", async () => {
    let fail!: () => void;
    const wait = new Promise<void>((resolve) => { fail = resolve; });
    const { service, options } = await setup(async () => { await wait; throw new Error("test disconnect"); });
    const entry = await service.request(scope, "create", { provider: "codex" });
    await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("first") });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
    await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("second") }); fail();
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).promptQueue).toMatchObject({ paused: true, error: "test disconnect", items: [{ requestId: "second" }] }));
    expect(options.run).toHaveBeenCalledOnce();
  });
  it("stops the current run while retaining unsent work, then explicitly resumes it", async () => {
    let settleCancellation!: () => void;
    const cancelled = new Promise<void>((resolve) => { settleCancellation = resolve; });
    const { service, options } = await setup(async (input, _emit, signal) => {
      if (input.content === "first") { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); await cancelled; }
      return { output: "done" };
    });
    const entry = await service.request(scope, "create", { provider: "codex" });
    await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("first") });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
    await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("second") });
    await service.request(scope, "queueUpdate", { id: entry.id, action: "stop" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[0]?.status).toBe("cancelled"));
    expect(options.run).toHaveBeenCalledOnce();
    expect((await service.request(scope, "read", { id: entry.id })).promptQueue).toMatchObject({ paused: true, items: [{ requestId: "second" }] });
    await service.request(scope, "queueUpdate", { id: entry.id, action: "resume" });
    settleCancellation();
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledTimes(2));
  });
  it("send-now waits for cancellation and moves the selected message ahead of the queue", async () => {
    const { service, options } = await setup(async (input, _emit, signal) => {
      if (input.content === "first") await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { output: "done" };
    });
    const entry = await service.request(scope, "create", { provider: "claude" });
    await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("first") });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
    await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("second") });
    await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("third") });
    await service.request(scope, "queueUpdate", { id: entry.id, action: "sendNow", requestId: "third" });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledTimes(3));
    expect(options.run.mock.calls.map(([input]) => input.content)).toEqual(["first", "third", "second"]);
  });
  it.each([false, true])("owns queued cloud invocation and result synchronization without a renderer (ambiguous send: %s)", async (ambiguous) => {
    const { service, options } = await setup(async () => ({ output: "local next" }));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const cloud = vi.fn(async (method: string, path: string) => {
      if (path === "/api/chat/sessions") return { id: "cloud-chat", workspace_id: scope.workspaceId };
      if (method === "POST" && path.endsWith("/messages")) {
        await gate;
        if (ambiguous) throw new Error("Connection lost after sending; inspect cloud chat");
        return { task_id: "cloud-run", message_id: "cloud-input", created_at: new Date().toISOString() };
      }
      if (path.includes("/messages/page")) return { messages: [{ id: "reply", chat_session_id: "cloud-chat", role: "assistant", task_id: "cloud-run", content: "cloud done" }] };
      return [];
    });
    Object.assign(options, { queueCloudClient: async () => cloud });
    const entry = await service.request(scope, "create", { provider: "codex" });
    const item = { ...prompt("cloud"), references: [{ kind: "agent" as const, id: "defined-agent" }], agents: [{ id: "defined-agent", name: "Defined agent" }] };
    await service.request(scope, "queueEnqueue", { id: entry.id, item });
    await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("next"), paused: true });
    await service.request(scope, "queueUpdate", { id: entry.id, action: "resume" });
    finish();
    if (ambiguous) {
      await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).promptQueue).toMatchObject({ paused: true, items: [{ requestId: "next" }] }));
      expect(options.run).not.toHaveBeenCalled();
    } else await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
    expect(cloud.mock.calls.filter(([method, path]) => method === "POST" && path.endsWith("/messages"))).toHaveLength(1);
  });
  it("moves a queued prompt to Side once without executing it in the source", async () => {
    const { service, options } = await setup(async () => ({ output: "done" }));
    const entry = await service.request(scope, "create", { provider: "claude" });
    await service.request(scope, "queueEnqueue", { id: entry.id, item: prompt("side"), paused: true });
    const side = await service.request(scope, "queueSide", { id: entry.id, requestId: "side" });
    expect((await service.request(scope, "queueSide", { id: entry.id, requestId: "side" })).id).toBe(side.id);
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
    expect(options.run.mock.calls[0]?.[0].content).toContain("side");
    expect((await service.request(scope, "read", { id: entry.id })).promptQueue?.items).toEqual([]);
    expect((await service.request(scope, "read", { id: entry.id })).turns).toEqual([]);
  });
});
