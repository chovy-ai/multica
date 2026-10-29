// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";
import { LocalConversationService } from "../../../../apps/desktop/src/local-host/local-conversation-service";
import { createDesktopQueueEngine } from "./desktop-queue-engine";
import { createDesktopPendingStore } from "./desktop-pending-store";
import type { LocalPromptQueue, LocalQueuedPrompt } from "@multica/core/local-conversation/protocol";

const scope = { userId: "removal-user", workspaceId: "removal-workspace" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const prompt: LocalQueuedPrompt = { requestId: "first-submit", content: "Keep or remove this first prompt",
  display: { id: "first-submit", clientSubmitId: "first-submit", createdAtUnixMs: 1,
    content: [{ type: "text", text: "Keep or remove this first prompt" }] } };

async function setup(provider: "codex" | "claude" = "codex") {
  const root = await mkdtemp(join(tmpdir(), "multica-pending-removal-"));
  const run = vi.fn(async () => ({ output: "fake reply" }));
  const service = new LocalConversationService({ root, apiUrl: "https://removal.test", run,
    find: async () => "/test-owned/fake-provider", chooseDirectory: async () => null, notify: vi.fn() });
  service.setCurrentUser(scope.userId);
  cleanup.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  const session = await service.request(scope, "create", { provider });
  const pendingStore = createDesktopPendingStore();
  const base = createAgentSessionEngine({ identity: { workspaceId: scope.workspaceId, origin: "multica" },
    clock: { nowUnixMs: () => Date.now() }, scheduler: { schedule: (delay, callback) => {
      const timer = setTimeout(callback, delay); return { cancel: () => clearTimeout(timer) };
    } }, commandPort: { kind: "typed", effects: { sendInput: vi.fn(), activateSession: vi.fn(), cancelTurn: vi.fn(),
      deleteSessions: vi.fn(), respondToInteraction: vi.fn(), renameSession: vi.fn(), setSessionPinned: vi.fn(), updateSessionSettings: vi.fn() }, execute: vi.fn() } });
  const enqueue = vi.fn(async (): Promise<LocalPromptQueue> => service.request(scope, "queueEnqueue", { id: session.id, item: prompt, paused: true }));
  const update = vi.fn((id: string, action: "pause" | "stop" | "resume" | "remove" | "sendNow", requestId?: string) => service.request(scope, "queueUpdate", { id, action, requestId }));
  const error = vi.fn();
  const adapter = createDesktopQueueEngine(base, { enabled: () => true, pendingStore, enqueue, update, error });
  cleanup.push(async () => adapter.engine.dispose());
  const submit = () => adapter.engine.submitPrompt({ agentSessionId: session.id, clientSubmitId: prompt.requestId, content: prompt.display.content });
  const remove = () => adapter.engine.dispatch({ type: "queue/removed", agentSessionId: session.id, promptId: prompt.requestId });
  const read = () => service.request(scope, "read", { id: session.id });
  const prompts = () => adapter.engine.getSnapshot().promptQueue.recordsBySessionId[session.id]?.prompts;
  return { ...adapter, service, session, enqueue, update, error, run, pendingStore, submit, remove, read, prompts };
}

it.each(["codex", "claude"] as const)("removes a rejected first %s prompt using the real service and clears its recovery checkpoint", async (provider) => {
  const data = await setup(provider);
  data.enqueue.mockRejectedValueOnce(Object.assign(new Error("Admission rejected"), provider === "codex" ? { status: 422 } : {}));
  data.submit();
  await vi.waitFor(() => expect(data.error).toHaveBeenCalledOnce());
  expect(data.pendingStore.getState().queues[0]?.prompts).toHaveLength(1);
  expect((await data.read()).turns).toEqual([]);
  data.remove();
  await vi.waitFor(() => expect(data.prompts()).toEqual([]));
  expect(data.error).toHaveBeenCalledOnce();
  expect(data.pendingStore.getState().queues).toEqual([]);
  expect(data.engine.getSnapshot().promptQueue.recordsBySessionId[data.session.id]?.failureMessage).toBeNull();
  expect((await data.read()).messages).toEqual([]);
  expect(data.run).not.toHaveBeenCalled();
  await expect(data.service.request(scope, "queueUpdate", { id: data.session.id, action: "remove", requestId: prompt.requestId })).resolves.toMatchObject({ items: [] });
});

it("waits for a rejected in-flight admission before removing its local checkpoint", async () => {
  const data = await setup();
  let reject!: (error: Error) => void;
  data.enqueue.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  data.submit(); data.remove();
  expect(data.update).not.toHaveBeenCalled();
  reject(new Error("Admission rejected"));
  await vi.waitFor(() => expect(data.prompts()).toEqual([]));
  expect(data.pendingStore.getState().queues).toEqual([]);
  expect(data.run).not.toHaveBeenCalled();
});

it("removes an accepted waiting prompt after its admission acknowledgement was lost", async () => {
  const data = await setup();
  data.enqueue.mockImplementationOnce(async () => {
    await data.service.request(scope, "queueEnqueue", { id: data.session.id, item: prompt, paused: true });
    throw new Error("Lost admission acknowledgement");
  });
  data.submit();
  await vi.waitFor(() => expect(data.error).toHaveBeenCalledOnce());
  expect((await data.read()).promptQueue?.items).toHaveLength(1);
  data.remove();
  await vi.waitFor(() => expect(data.prompts()).toEqual([]));
  expect((await data.read()).promptQueue?.items).toEqual([]);
  expect(data.pendingStore.getState().queues).toEqual([]);
  expect(data.run).not.toHaveBeenCalled();
});

it.each(["running", "completed", "side"] as const)("preserves an accepted %s prompt when its admission acknowledgement was lost", async (state) => {
  const data = await setup();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  data.run.mockImplementation(async () => { await gate; return { output: "fake reply" }; });
  cleanup.push(async () => finish());
  data.enqueue.mockImplementationOnce(async () => {
    await data.service.request(scope, "queueEnqueue", { id: data.session.id, item: prompt, paused: state === "side" });
    if (state === "side") await data.service.request(scope, "queueSide", { id: data.session.id, requestId: prompt.requestId });
    else {
      await vi.waitFor(() => expect(data.run).toHaveBeenCalledOnce());
      if (state === "completed") {
        finish();
        await vi.waitFor(async () => expect((await data.read()).turns[0]?.status).toBe("completed"));
      }
    }
    throw new Error("Lost admission acknowledgement");
  });
  data.submit();
  await vi.waitFor(() => expect(data.error).toHaveBeenCalledOnce());
  data.remove();
  await vi.waitFor(() => expect(data.error).toHaveBeenCalledTimes(2));
  expect(data.error.mock.calls[1]?.[0]).toMatchObject({ message: "This queued message has already started" });
  expect(data.prompts()).toHaveLength(1);
  expect(data.pendingStore.getState().queues[0]?.prompts).toHaveLength(1);
  if (state !== "side") expect((await data.read()).turns[0]?.status).toBe(state === "running" ? "running" : "completed");
});
