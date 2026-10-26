// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionEngine, selectSessionIsSubmitting } from "@tutti-os/agent-activity-core";
import { createDesktopQueueEngine } from "./desktop-queue-engine";
import type { LocalPromptQueue, LocalQueuedPrompt } from "../local-protocol";

function setup(running = false) {
  const sendInput = vi.fn();
  const base = createAgentSessionEngine({ identity: { workspaceId: "ws", origin: "multica" },
    clock: { nowUnixMs: () => Date.now() }, scheduler: { schedule: (delay, callback) => { const timer = setTimeout(callback, delay); return { cancel: () => clearTimeout(timer) }; } },
    commandPort: { kind: "typed", effects: { sendInput, activateSession: vi.fn(), cancelTurn: vi.fn(), deleteSessions: vi.fn(), respondToInteraction: vi.fn(), renameSession: vi.fn(), setSessionPinned: vi.fn(), updateSessionSettings: vi.fn() }, execute: vi.fn() } });
  base.dispatch({ type: "session/snapshotReceived", sessions: [{ agentSessionId: "session", workspaceId: "ws", provider: "codex", title: "Conversation", cwd: "/workspace", activeTurnId: running ? "active" : null,
    ...(running ? { activeTurn: { agentSessionId: "session", turnId: "active", origin: "user_prompt", phase: "running", startedAtUnixMs: 1, updatedAtUnixMs: 1 } } : {}), pendingInteractions: [], latestTurnInteractions: [] }] });
  const options = { enabled: () => true, enqueue: vi.fn(async (): Promise<LocalPromptQueue> => ({ revision: 1, paused: false, items: [] })),
    update: vi.fn(async () => ({ revision: 2, paused: true, items: [] })), error: vi.fn() };
  const adapter = createDesktopQueueEngine(base, options);
  return { ...adapter, options, sendInput };
}
function queued(requestId: string): LocalQueuedPrompt {
  return { requestId, content: requestId, display: { id: requestId, clientSubmitId: requestId, createdAtUnixMs: 1, content: [{ type: "text", text: requestId }] } };
}
const submit = (engine: ReturnType<typeof setup>["engine"], id: string) => engine.submitPrompt({ agentSessionId: "session", clientSubmitId: id, content: [{ type: "text", text: id }] });
const visible = (engine: ReturnType<typeof setup>["engine"]) => engine.getSnapshot().promptQueue.recordsBySessionId.session?.prompts.filter((prompt) => prompt.visibleInQueue !== false).map((prompt) => prompt.id) ?? [];
describe("desktop queue presentation", () => {
  it("transfers admission to Electron and does not drain or pause it on GUI disposal", async () => {
    const { engine, options, sendInput } = setup();
    expect(engine.submitPrompt({ agentSessionId: "session", clientSubmitId: "submit", content: [{ type: "text", text: "continue" }] })).toEqual({ accepted: true, queued: false });
    await vi.waitFor(() => expect(options.enqueue).toHaveBeenCalledOnce());
    engine.dispose();
    expect(sendInput).not.toHaveBeenCalled(); expect(options.update).not.toHaveBeenCalled();
  });
  it("keeps an idle submit out of the queue before and after desktop admission", async () => {
    const { engine, receive, options } = setup();
    let accept!: (queue: LocalPromptQueue) => void;
    options.enqueue.mockImplementation(() => new Promise((resolve) => { accept = resolve; }));
    expect(submit(engine, "first")).toEqual({ accepted: true, queued: false });
    expect(visible(engine)).toEqual([]);
    expect(selectSessionIsSubmitting(engine.getSnapshot(), "session")).toBe(true);
    const receipt = { revision: 1, paused: false, items: [queued("first")], dispatchingRequestId: "first" };
    receive("session", receipt); accept(receipt);
    await vi.waitFor(() => expect(options.enqueue).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(visible(engine)).toEqual([]);
    expect(selectSessionIsSubmitting(engine.getSnapshot(), "session")).toBe(true);
    receive("session", { revision: 2, paused: false, items: [] });
    expect(selectSessionIsSubmitting(engine.getSnapshot(), "session")).toBe(false);
    engine.dispose();
  });
  it("shows only later submissions while the first idle admission is pending", async () => {
    const { engine, options } = setup();
    options.enqueue.mockImplementation(() => new Promise(() => {}));
    expect(submit(engine, "first").queued).toBe(false);
    expect(submit(engine, "second").queued).toBe(true);
    expect(visible(engine)).toEqual(["second"]);
    engine.dispose();
  });
  it("shows a single waiting submission when a previous turn is active", () => {
    const { engine, options } = setup(true);
    options.enqueue.mockImplementation(() => new Promise(() => {}));
    expect(submit(engine, "waiting").queued).toBe(true);
    expect(visible(engine)).toEqual(["waiting"]);
    engine.dispose();
  });
  it("reveals a previously hidden submission if admission fails", async () => {
    const { engine, options } = setup();
    options.enqueue.mockRejectedValue(new Error("Admission unavailable"));
    submit(engine, "retry-me");
    expect(visible(engine)).toEqual([]);
    await vi.waitFor(() => expect(options.error).toHaveBeenCalledOnce());
    expect(visible(engine)).toEqual(["retry-me"]);
    expect(engine.getSnapshot().promptQueue.recordsBySessionId.session?.failureMessage).toBe("Admission unavailable");
    expect(selectSessionIsSubmitting(engine.getSnapshot(), "session")).toBe(false);
    engine.dispose();
  });
  it("projects dispatching separately from waiting, paused and failed desktop records", () => {
    const { engine, receive } = setup();
    receive("session", { revision: 1, paused: false, dispatchingRequestId: "first", items: [queued("first"), queued("second")] });
    expect(visible(engine)).toEqual(["second"]);
    receive("session", { revision: 2, paused: true, items: [queued("first"), queued("second")] });
    expect(visible(engine)).toEqual(["first", "second"]);
    receive("session", { revision: 3, paused: false, error: "Try again", items: [queued("first")] });
    expect(visible(engine)).toEqual(["first"]);
    engine.dispose();
  });
  it("projects durable queues on remount and ignores stale replies", () => {
    const { engine, receive } = setup();
    const item = { requestId: "submit", content: "next", display: { id: "submit", clientSubmitId: "submit", createdAtUnixMs: 1, content: [{ type: "text" as const, text: "next" }] } };
    receive("session", { revision: 5, paused: false, items: [item] });
    receive("session", { revision: 4, paused: true, items: [] });
    const queue = engine.getSnapshot().promptQueue.recordsBySessionId.session!;
    expect(queue.prompts).toEqual([item.display]); expect(queue.suspendReason).toBeNull();
    expect(engine.getSnapshot()).toBe(engine.getSnapshot()); engine.dispose();
  });
  it("routes queue removal, send-now and stop to Electron", async () => {
    const { engine, options } = setup();
    engine.dispatch({ type: "queue/removed", agentSessionId: "session", promptId: "removed" });
    engine.dispatch({ type: "queue/sendNowRequested", agentSessionId: "session", promptId: "next", awaitingTurnExpiresAtUnixMs: 1000, cancelCommandId: "cancel", timeoutMs: 1000 });
    engine.stopSession({ agentSessionId: "session" });
    expect(options.update.mock.calls).toEqual([["session", "remove", "removed"], ["session", "sendNow", "next"], ["session", "stop"]]);
    await Promise.resolve(); engine.dispose();
  });
});
