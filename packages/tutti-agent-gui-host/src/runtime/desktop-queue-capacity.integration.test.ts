// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";
import { LocalConversationService } from "../../../../apps/desktop/src/local-host/local-conversation-service";
import { createDesktopQueueEngine } from "./desktop-queue-engine";
import { createDesktopPendingStore } from "./desktop-pending-store";

it("keeps an over-capacity draft out of the real desktop queue and recovery checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "multica-queue-capacity-"));
  const scope = { userId: "queue-user", workspaceId: "queue-workspace" };
  const run = vi.fn(async () => ({ output: "unused" }));
  const service = new LocalConversationService({ root, apiUrl: "https://queue.test", notify: vi.fn(),
    chooseDirectory: async () => null, find: async () => "/test-owned/fake-cli", run });
  service.setCurrentUser(scope.userId);
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const restore = () => createDesktopPendingStore(storage, "capacity-test");
  const setup = () => {
    const base = createAgentSessionEngine({ identity: { workspaceId: scope.workspaceId, origin: "multica" },
      clock: { nowUnixMs: () => Date.now() }, scheduler: { schedule: (delay, callback) => {
        const timer = setTimeout(callback, delay); return { cancel: () => clearTimeout(timer) };
      } }, commandPort: { kind: "typed", effects: { sendInput: vi.fn(), activateSession: vi.fn(), cancelTurn: vi.fn(),
        deleteSessions: vi.fn(), respondToInteraction: vi.fn(), renameSession: vi.fn(), setSessionPinned: vi.fn(), updateSessionSettings: vi.fn() }, execute: vi.fn() } });
    const enqueue = vi.fn((input: Parameters<typeof base.submitPrompt>[0]) => service.request(scope, "queueEnqueue", {
      id: input.agentSessionId, paused: true, item: { requestId: input.clientSubmitId!,
        content: input.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""),
        display: { ...input, id: input.clientSubmitId!, createdAtUnixMs: 1 } },
    }));
    const adapter = createDesktopQueueEngine(base, { pendingStore: restore(), enabled: () => true, enqueue,
      update: (id, action, requestId) => service.request(scope, "queueUpdate", { id, action, requestId }), error: vi.fn() });
    return { ...adapter, enqueue };
  };
  let first: ReturnType<typeof setup> | undefined;
  let next: ReturnType<typeof setup> | undefined;
  try {
    const session = await service.request(scope, "create", { provider: "codex" });
    for (let index = 0; index < 100; index++) {
      const id = `saved-${index}`;
      await service.request(scope, "queueEnqueue", { id: session.id, paused: true,
        item: { requestId: id, content: id, display: { id, clientSubmitId: id, createdAtUnixMs: 1, content: [{ type: "text", text: id }] } } });
    }
    // Other windows can bypass the presentation guard; the canonical service
    // must still reject them without growing its persisted queue.
    await expect(service.request(scope, "queueEnqueue", { id: session.id, paused: true,
      item: { requestId: "external-overflow", content: "external", display: { id: "external-overflow", createdAtUnixMs: 1,
        content: [{ type: "text", text: "external" }] } } })).rejects.toThrow("queue is full");
    first = setup();
    first.receive(session.id, (await service.request(scope, "read", { id: session.id })).promptQueue);
    const input = { agentSessionId: session.id, clientSubmitId: "over-capacity", content: [{ type: "text" as const, text: "Keep this draft" }] };
    expect(first.engine.submitPrompt(input)).toEqual({ accepted: false, queued: false });
    expect(first.enqueue).not.toHaveBeenCalled();
    expect(restore().getState().queues).toEqual([]);
    first.engine.dispose(); first = undefined;
    next = setup();
    next.receive(session.id, (await service.request(scope, "read", { id: session.id })).promptQueue);
    expect(next.engine.getSnapshot().promptQueue.recordsBySessionId[session.id]?.prompts).toHaveLength(100);
    expect(restore().getState().queues).toEqual([]);
    next.engine.dispatch({ type: "queue/removed", agentSessionId: session.id, promptId: "saved-0" });
    await vi.waitFor(() => expect(next!.engine.getSnapshot().promptQueue.recordsBySessionId[session.id]?.prompts).toHaveLength(99));
    expect(next.engine.submitPrompt(input).accepted).toBe(true);
    await vi.waitFor(() => expect(restore().getState().queues).toEqual([]));
    expect((await service.request(scope, "read", { id: session.id })).promptQueue?.items).toHaveLength(100);
    expect(next.enqueue).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  } finally { first?.engine.dispose(); next?.engine.dispose(); await service.stop(); await rm(root, { recursive: true, force: true }); }
});
