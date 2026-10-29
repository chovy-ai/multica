// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";
import { LocalConversationService } from "../../../../apps/desktop/src/local-host/local-conversation-service";
import { createDesktopQueueEngine } from "./desktop-queue-engine";
import { createDesktopPendingStore } from "./desktop-pending-store";

it.each(["rejected", "lost acknowledgement"])("discards an unconfirmed submission after %s only when the host confirms removal", async (outcome) => {
  const root = await mkdtemp(join(tmpdir(), "multica-queue-removal-"));
  const scope = { userId: "queue-user", workspaceId: "queue-workspace" };
  const run = vi.fn(async () => ({ output: "unused" }));
  const service = new LocalConversationService({ root, apiUrl: "https://queue.test", notify: vi.fn(),
    chooseDirectory: async () => null, find: async () => "/test-owned/fake-cli", run });
  service.setCurrentUser(scope.userId);
  const values = new Map<string, string>();
  const restore = () => createDesktopPendingStore({ getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } }, "removal-test");
  const base = createAgentSessionEngine({ identity: { workspaceId: scope.workspaceId, origin: "multica" },
    clock: { nowUnixMs: () => Date.now() }, scheduler: { schedule: (delay, callback) => {
      const timer = setTimeout(callback, delay); return { cancel: () => clearTimeout(timer) };
    } }, commandPort: { kind: "typed", effects: { sendInput: vi.fn(), activateSession: vi.fn(), cancelTurn: vi.fn(),
      deleteSessions: vi.fn(), respondToInteraction: vi.fn(), renameSession: vi.fn(), setSessionPinned: vi.fn(), updateSessionSettings: vi.fn() }, execute: vi.fn() } });
  const enqueue = vi.fn(async (input: Parameters<typeof base.submitPrompt>[0]) => {
    if (outcome === "lost acknowledgement") await service.request(scope, "queueEnqueue", {
      id: input.agentSessionId, paused: true, item: { requestId: input.clientSubmitId!, content: "Keep my message",
        display: { ...input, id: input.clientSubmitId!, createdAtUnixMs: 1 } },
    });
    throw new Error(outcome === "rejected" ? "Mentioned agent is not available" : "Connection lost after admission");
  });
  const update = vi.fn((id: string, action: "pause" | "stop" | "resume" | "remove" | "sendNow", requestId?: string) =>
    service.request(scope, "queueUpdate", { id, action, requestId }));
  const error = vi.fn();
  const { engine, receive } = createDesktopQueueEngine(base, { pendingStore: restore(), enabled: () => true, enqueue, update, error });
  try {
    const session = await service.request(scope, "create", { provider: "codex" });
    receive(session.id, await service.request(scope, "queueUpdate", { id: session.id, action: "pause" }));
    engine.submitPrompt({ agentSessionId: session.id, clientSubmitId: "unconfirmed", content: [{ type: "text", text: "Keep my message" }] });
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    const record = () => engine.getSnapshot().promptQueue.recordsBySessionId[session.id];
    const remove = () => engine.dispatch({ type: "queue/removed", agentSessionId: session.id, promptId: "unconfirmed" });
    if (outcome === "rejected") receive(session.id, (await service.request(scope, "read", { id: session.id })).promptQueue);
    expect(record()?.prompts).toHaveLength(1);
    expect(restore().getState().queues[0]?.prompts[0]?.content).toEqual([{ type: "text", text: "Keep my message" }]);
    update.mockRejectedValueOnce(new Error("Removal unavailable"));
    remove();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
    expect(record()?.prompts).toHaveLength(1);
    expect(restore().getState().queues).toHaveLength(1);
    remove(); remove();
    await vi.waitFor(() => expect(record()?.prompts).toEqual([]));
    expect(record()?.failureMessage).toBeNull();
    expect(restore().getState().queues).toEqual([]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);
    remove();
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(record()?.failureMessage).toBeNull());
    expect(error).toHaveBeenCalledTimes(2);
    expect((await service.request(scope, "read", { id: session.id })).promptQueue).toMatchObject({ paused: true, items: [] });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  } finally { engine.dispose(); await service.stop(); await rm(root, { recursive: true, force: true }); }
});
