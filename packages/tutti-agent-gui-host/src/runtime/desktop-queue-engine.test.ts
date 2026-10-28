// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionEngine, selectSessionIsSubmitting } from "@tutti-os/agent-activity-core";
import { createDesktopQueueEngine } from "./desktop-queue-engine";
import { createDesktopPendingStore, type DesktopPendingStore } from "./desktop-pending-store";
import type { LocalPromptQueue, LocalQueuedPrompt } from "@multica/core/local-conversation/protocol";
type SubmitInput = Parameters<ReturnType<typeof createAgentSessionEngine>["submitPrompt"]>[0];

function setup(running = false, pendingStore?: DesktopPendingStore) {
  const sendInput = vi.fn();
  const base = createAgentSessionEngine({ identity: { workspaceId: "ws", origin: "multica" },
    clock: { nowUnixMs: () => Date.now() }, scheduler: { schedule: (delay, callback) => { const timer = setTimeout(callback, delay); return { cancel: () => clearTimeout(timer) }; } },
    commandPort: { kind: "typed", effects: { sendInput, activateSession: vi.fn(), cancelTurn: vi.fn(), deleteSessions: vi.fn(), respondToInteraction: vi.fn(), renameSession: vi.fn(), setSessionPinned: vi.fn(), updateSessionSettings: vi.fn() }, execute: vi.fn() } });
  base.dispatch({ type: "session/snapshotReceived", sessions: [{ agentSessionId: "session", workspaceId: "ws", provider: "codex", title: "Conversation", cwd: "/workspace", activeTurnId: running ? "active" : null,
    ...(running ? { activeTurn: { agentSessionId: "session", turnId: "active", origin: "user_prompt", phase: "running", startedAtUnixMs: 1, updatedAtUnixMs: 1 } } : {}), pendingInteractions: [], latestTurnInteractions: [] }] });
  const options = { pendingStore, enabled: () => true, enqueue: vi.fn(async (_input: SubmitInput): Promise<LocalPromptQueue> => ({ revision: 1, paused: false, items: [] })),
    update: vi.fn(async () => ({ revision: 2, paused: true, items: [] })), error: vi.fn() };
  const adapter = createDesktopQueueEngine(base, options);
  return { ...adapter, options, sendInput };
}
function queued(requestId: string): LocalQueuedPrompt {
  return { requestId, content: requestId, display: { id: requestId, clientSubmitId: requestId, createdAtUnixMs: 1, content: [{ type: "text", text: requestId }] } };
}
const submit = (engine: ReturnType<typeof setup>["engine"], id: string) => engine.submitPrompt({ agentSessionId: "session", clientSubmitId: id, content: [{ type: "text", text: id }] });
const sendNow = (engine: ReturnType<typeof setup>["engine"], promptId: string) => engine.dispatch({ type: "queue/sendNowRequested", agentSessionId: "session", promptId, awaitingTurnExpiresAtUnixMs: 30000, cancelCommandId: "cancel", timeoutMs: 30000 });
const visible = (engine: ReturnType<typeof setup>["engine"]) => engine.getSnapshot().promptQueue.recordsBySessionId.session?.prompts.filter((prompt) => prompt.visibleInQueue !== false).map((prompt) => prompt.id) ?? [];
describe("desktop queue presentation", () => {
  it("retains send-now errors across snapshots until the operation succeeds", async () => {
    const { engine, receive, options } = setup(true);
    receive("session", { revision: 1, paused: false, items: [queued("next")] });
    options.update.mockRejectedValue(new Error("Queue update unavailable"));
    try {
      engine.dispatch({ type: "queue/sendNowRequested", agentSessionId: "session", promptId: "next", awaitingTurnExpiresAtUnixMs: 1000, cancelCommandId: "cancel", timeoutMs: 1000 });
      await vi.waitFor(() => expect(options.error).toHaveBeenCalledOnce());
      expect(visible(engine)).toEqual(["next"]);
      expect(engine.getSnapshot().promptQueue.recordsBySessionId.session?.failureMessage).toBe("Queue update unavailable");
      receive("session", { revision: 3, paused: false, items: [queued("next")] });
      expect(engine.getSnapshot().promptQueue.recordsBySessionId.session?.failureMessage).toBe("Queue update unavailable");
      options.update.mockResolvedValue({ revision: 4, paused: false, items: [] });
      sendNow(engine, "next");
      await vi.waitFor(() => expect(visible(engine)).toEqual([]));
      expect(engine.getSnapshot().promptQueue.recordsBySessionId.session?.failureMessage).toBeNull();
    } finally { engine.dispose(); }
  });
  it("waits for an in-flight image admission and coalesces repeated send-now clicks", async () => {
    const { engine, options } = setup(true);
    let accept!: (queue: LocalPromptQueue) => void;
    options.enqueue.mockImplementation(() => new Promise((resolve) => { accept = resolve; }));
    const input = { agentSessionId: "session", clientSubmitId: "image", content: [{ type: "text" as const, text: "use this image" }, { type: "image" as const, attachmentId: "saved-image", mimeType: "image/png" }] };
    engine.submitPrompt(input);
    sendNow(engine, "image"); sendNow(engine, "image");
    expect(options.update).not.toHaveBeenCalled();
    expect(options.enqueue).toHaveBeenCalledOnce();
    accept({ revision: 1, paused: false, items: [{ ...queued("image"), attachmentIds: ["saved-image"] }] });
    await vi.waitFor(() => expect(options.update).toHaveBeenCalledOnce());
    expect(options.update).toHaveBeenCalledWith("session", "sendNow", "image");
    expect(options.enqueue).toHaveBeenCalledWith(input);
    engine.dispose();
  });
  it("retries failed admission explicitly with the original submission and preserves its error on refresh", async () => {
    const { engine, receive, options } = setup(true);
    options.enqueue.mockRejectedValueOnce(new Error("Admission unavailable"));
    const input = { agentSessionId: "session", clientSubmitId: "retry", content: [{ type: "text" as const, text: "original" }, { type: "image" as const, attachmentId: "saved-image" }] };
    engine.submitPrompt(input);
    await vi.waitFor(() => expect(options.error).toHaveBeenCalledOnce());
    receive("session", { revision: 1, paused: false, items: [] });
    expect(engine.getSnapshot().promptQueue.recordsBySessionId.session?.failureMessage).toBe("Admission unavailable");
    expect(options.enqueue).toHaveBeenCalledOnce();
    input.content[0]!.text = "changed after submission";
    options.enqueue.mockResolvedValue({ revision: 2, paused: false, items: [queued("retry")] });
    sendNow(engine, "retry"); sendNow(engine, "retry");
    await vi.waitFor(() => expect(options.update).toHaveBeenCalledOnce());
    expect(options.enqueue).toHaveBeenCalledTimes(2);
    expect(options.enqueue.mock.calls[1]?.[0]).toMatchObject({ clientSubmitId: "retry", content: [{ type: "text", text: "original" }, { type: "image", attachmentId: "saved-image" }] });
    expect(engine.getSnapshot().promptQueue.recordsBySessionId.session?.failureMessage).toBeNull();
    engine.dispose();
  });
  it("confirms a lost admission receipt with the same ID without sending an already executed prompt again", async () => {
    const { engine, receive, options } = setup();
    options.enqueue.mockRejectedValueOnce(new Error("The host request timed out"));
    submit(engine, "completed");
    await vi.waitFor(() => expect(options.error).toHaveBeenCalledOnce());
    receive("session", { revision: 2, paused: false, items: [] });
    options.enqueue.mockResolvedValue({ revision: 3, paused: false, items: [] });
    sendNow(engine, "completed");
    await vi.waitFor(() => expect(visible(engine)).toEqual([]));
    expect(options.enqueue).toHaveBeenCalledTimes(2);
    expect(options.enqueue.mock.calls[1]?.[0]).toEqual(options.enqueue.mock.calls[0]?.[0]);
    expect(options.update).not.toHaveBeenCalled();
    engine.dispose();
  });
  it("uses an authoritative admission snapshot even when the RPC acknowledgement fails later", async () => {
    const { engine, receive, options } = setup();
    let reject!: (error: Error) => void;
    options.enqueue.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    submit(engine, "confirmed");
    receive("session", { revision: 1, paused: false, items: [queued("confirmed")], dispatchingRequestId: "confirmed" });
    receive("session", { revision: 2, paused: false, items: [] });
    reject(new Error("The host request timed out"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(visible(engine)).toEqual([]);
    expect(options.error).not.toHaveBeenCalled();
    engine.dispose();
  });
  it("does not interrupt a prompt that starts dispatching while send-now awaits admission", async () => {
    const { engine, options } = setup(true);
    let accept!: (queue: LocalPromptQueue) => void;
    options.enqueue.mockImplementation(() => new Promise((resolve) => { accept = resolve; }));
    submit(engine, "dispatching");
    sendNow(engine, "dispatching");
    accept({ revision: 1, paused: false, items: [queued("dispatching")], dispatchingRequestId: "dispatching" });
    await vi.waitFor(() => expect(visible(engine)).toEqual([]));
    expect(options.update).not.toHaveBeenCalled();
    engine.dispose();
  });
  it("keeps a newer operation error when a late admission response succeeds", async () => {
    const { engine, receive, options } = setup(true);
    let accept!: (queue: LocalPromptQueue) => void;
    options.enqueue.mockImplementation(() => new Promise((resolve) => { accept = resolve; }));
    submit(engine, "next");
    const receipt = { revision: 1, paused: false, items: [queued("next")] };
    receive("session", receipt);
    options.update.mockRejectedValue(new Error("Cancellation failed"));
    sendNow(engine, "next");
    await vi.waitFor(() => expect(options.error).toHaveBeenCalledOnce());
    accept(receipt);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.getSnapshot().promptQueue.recordsBySessionId.session?.failureMessage).toBe("Cancellation failed");
    engine.dispose();
  });
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
    expect(options.update.mock.calls).toEqual([["session", "remove", "removed"], ["session", "sendNow", "next"], ["session", "stop", undefined]]);
    await Promise.resolve(); engine.dispose();
  });
});

function pendingStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}

describe("unconfirmed desktop submissions across document lifetimes", () => {
  it("checkpoints before returning accepted and restores rejection without replay, retrying the same ID", async () => {
    const storage = pendingStorage();
    const restore = () => createDesktopPendingStore(storage, "scope");
    const first = setup(false, restore());
    first.options.enqueue.mockRejectedValue(new Error("Admission rejected"));
    submit(first.engine, "original-id");
    expect(restore().getState().queues[0]?.prompts[0]?.clientSubmitId).toBe("original-id");
    await vi.waitFor(() => expect(first.options.error).toHaveBeenCalledOnce());
    first.engine.dispose();
    const next = setup(false, restore());
    try {
      expect(visible(next.engine)).toEqual(["original-id"]);
      expect(selectSessionIsSubmitting(next.engine.getSnapshot(), "session")).toBe(false);
      expect(next.options.enqueue).not.toHaveBeenCalled();
      sendNow(next.engine, "original-id");
      await vi.waitFor(() => expect(visible(next.engine)).toEqual([]));
      expect(next.options.enqueue).toHaveBeenCalledOnce();
      expect(next.options.enqueue.mock.calls[0]?.[0]).toMatchObject(first.options.enqueue.mock.calls[0]![0]);
      expect(next.options.update).not.toHaveBeenCalled();
      expect(restore().getState().queues).toEqual([]);
    } finally { next.engine.dispose(); }
  });
  it("restores in-flight admissions, reconciles canonical ownership, and ignores an old document's late failure", async () => {
    const storage = pendingStorage();
    const restore = () => createDesktopPendingStore(storage, "scope");
    const first = setup(false, restore());
    let reject!: (error: Error) => void;
    first.options.enqueue.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    submit(first.engine, "in-flight");
    first.engine.dispose();
    const next = setup(false, restore());
    try {
      expect(visible(next.engine)).toEqual(["in-flight"]);
      expect(next.options.enqueue).not.toHaveBeenCalled();
      next.receive("session", { revision: 1, paused: false, items: [queued("in-flight")], dispatchingRequestId: "in-flight" });
      expect(visible(next.engine)).toEqual([]);
      expect(restore().getState().queues).toEqual([]);
      reject(new Error("Lost acknowledgement"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(restore().getState().queues).toEqual([]);
      expect(first.options.error).not.toHaveBeenCalled();
    } finally { next.engine.dispose(); }
  });
  it("keeps a rejected submission on failed removal and clears it only after confirmed removal", async () => {
    const storage = pendingStorage();
    const restore = () => createDesktopPendingStore(storage, "scope");
    const handle = setup(false, restore());
    handle.options.enqueue.mockRejectedValue(new Error("Admission rejected"));
    submit(handle.engine, "discard");
    await vi.waitFor(() => expect(handle.options.error).toHaveBeenCalledOnce());
    const remove = () => handle.engine.dispatch({ type: "queue/removed", agentSessionId: "session", promptId: "discard" });
    try {
      handle.options.update.mockRejectedValueOnce(new Error("Removal failed"));
      remove();
      await vi.waitFor(() => expect(handle.options.error).toHaveBeenCalledTimes(2));
      expect(restore().getState().queues[0]?.prompts[0]?.id).toBe("discard");
      remove();
      await vi.waitFor(() => expect(visible(handle.engine)).toEqual([]));
      expect(restore().getState().queues).toEqual([]);
      expect(handle.options.enqueue).toHaveBeenCalledOnce();
    } finally { handle.engine.dispose(); }
  });
});
