// @vitest-environment node
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalClaudeConversation } from "./local-claude-conversation";
import { LocalConversationService } from "./local-conversation-service";

const scope = { userId: "fixture-user", workspaceId: "fixture-workspace" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class Messages {
  private values: SDKMessage[] = [];
  private ended = false;
  private wake?: () => void;
  push(value: unknown) { this.values.push(value as SDKMessage); this.wake?.(); }
  close() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.values.length) {
      if (this.values.length) yield this.values.shift()!;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}
const reply = (uuid: string | undefined, content: string) => ({ type: "assistant", user_message_uuid: uuid, message: { stop_reason: "end_turn", content: [{ type: "text", text: content }] } });
const result = (uuid: string | undefined, content: string) => ({ type: "result", user_message_uuid: uuid, result: content, is_error: false });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "multica-background-delivery-"));
  const messages = new Messages();
  const received: SDKUserMessage[] = [];
  const readers: Promise<void>[] = [];
  const transport = Object.assign(messages, {
    setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
    setModel: vi.fn(async () => {}), setPermissionMode: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}), stopTask: vi.fn(async () => {}),
  });
  const query = vi.fn(async (input: AsyncIterable<SDKUserMessage>, _options: Options) => {
    readers.push((async () => { for await (const item of input) received.push(item); })());
    return transport as unknown as Query;
  });
  const prepareContext = vi.fn<NonNullable<ConstructorParameters<typeof LocalConversationService>[0]["prepareContext"]>>(async () => ({ env: {}, systemPrompt: "Scoped fixture context", dispose: vi.fn(async () => {}) }));
  const notify = vi.fn();
  const options = { root, apiUrl: "https://fixture.test", notify, prepareContext,
    find: async () => "/test-owned/fake-claude", chooseDirectory: async () => null,
    claudeConversation: (onClose: () => Promise<void>) => new LocalClaudeConversation(onClose, {
      find: async () => "/test-owned/fake-claude", query,
      pluginSettings: async () => ({ enabledPlugins: {}, syncClaudeAiPlugins: false }),
    }),
  };
  const service = new LocalConversationService(options); service.setCurrentUser(scope.userId);
  cleanups.push(async () => { await service.stop(); await Promise.all(readers); await rm(root, { recursive: true, force: true }); });
  const entry = await service.request(scope, "create", { provider: "claude" });
  const read = () => service.request(scope, "read", { id: entry.id });
  const first = await service.request(scope, "send", { id: entry.id, content: "Review and summarize when done", permissionMode: "auto" });
  await vi.waitFor(() => expect(received).toHaveLength(1));
  messages.push({ type: "system", subtype: "init", session_id: "fixture-native-session" });
  messages.push({ type: "system", subtype: "task_started", task_id: "review", description: "Review", is_backgrounded: true });
  messages.push(reply(received[0]!.uuid, "Review is still running."));
  messages.push(result(received[0]!.uuid, "Review is still running."));
  await vi.waitFor(async () => expect((await read()).turns[0]?.status).toBe("completed"));
  const complete = (status = "completed", summary = "Review finished") => messages.push({ type: "system", subtype: "task_notification", task_id: "review", status, summary });
  const finishFollowup = async () => {
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 2500 });
    messages.push(reply(received[1]!.uuid, "Review results and decisions."));
    messages.push(result(received[1]!.uuid, "Review results and decisions."));
    await vi.waitFor(async () => expect((await read()).messages.at(-1)?.content).toBe("Review results and decisions."));
  };
  return { service, options, entry, first, read, messages, received, transport, prepareContext, query, notify, complete, finishFollowup };
}

describe("background results without a new user message", () => {
  it.each(["notification-only", "snapshot-only", "snapshot-and-assistant", "notification-and-assistant"])("delivers %s once in the source conversation", async (scenario) => {
    const f = await setup();
    if (scenario.startsWith("notification")) f.complete();
    f.messages.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    if (scenario.endsWith("-and-assistant")) f.messages.push(reply(f.received[0]!.uuid, "Review results and decisions."));
    f.messages.push(result(f.received[0]!.uuid, "Review finished"));
    if (!scenario.endsWith("-and-assistant")) await f.finishFollowup();
    await vi.waitFor(async () => expect((await f.read()).messages.at(-1)?.content).toBe("Review results and decisions."));
    const saved = await f.read();
    expect(saved.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(saved.turns[0]?.backgroundTasks?.[0]?.delivery?.status).toBe("delivered");
    expect(saved.messages.filter((message) => message.content === "Review results and decisions.")).toHaveLength(1);
    if (scenario.endsWith("-and-assistant")) {
      expect(saved.messages.at(-1)?.turnId).toBe(f.first.turnId);
      expect(f.received).toHaveLength(1);
    } else {
      expect(saved.turns[1]?.backgroundDelivery).toEqual({ sourceTurnId: f.first.turnId, taskIds: ["review"] });
      expect(f.prepareContext).toHaveBeenCalledTimes(2);
      expect(f.transport.setMcpServers).toHaveBeenCalledOnce();
      const prompt = String(f.received[1]!.message.content);
      expect(prompt).toContain("Continue only work already authorized");
      if (scenario === "snapshot-only") expect(prompt).toContain('"completionSource":"snapshot"');
    }
  });

  it("keeps a streaming native reply ahead of internal continuation", async () => {
    const f = await setup(); f.complete();
    f.messages.push({ type: "stream_event", user_message_uuid: f.received[0]!.uuid, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Review results" } } });
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(f.received).toHaveLength(1);
    f.messages.push({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } });
    f.messages.push(result(f.received[0]!.uuid, "Review results"));
    await vi.waitFor(async () => expect((await f.read()).messages.at(-1)?.content).toBe("Review results"));
    expect(f.received).toHaveLength(1);
  });

  it("waits for a new foreground message and routes a late native result back to the old turn", async () => {
    const f = await setup();
    const second = await f.service.request(scope, "send", { id: f.entry.id, content: "Another request" });
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    f.complete();
    f.messages.push(reply(f.received[0]!.uuid, "Old review result"));
    f.messages.push(result(f.received[0]!.uuid, "Late old result"));
    await vi.waitFor(async () => expect((await f.read()).messages.at(-1)?.content).toBe("Old review result"));
    expect((await f.read()).turns.find((turn) => turn.id === second.turnId)?.status).toBe("running");
    expect((await f.read()).messages.at(-1)?.turnId).toBe(f.first.turnId);
    f.messages.push(reply(f.received[1]!.uuid, "New result"));
    f.messages.push(result(f.received[1]!.uuid, "New result"));
    await vi.waitFor(async () => expect((await f.read()).turns[1]?.status).toBe("completed"));
    expect(f.received).toHaveLength(2);
  });

  it.each(["failed", "stopped"])("reports %s and preserves the original evidence", async (status) => {
    const f = await setup(); f.complete(status, "Review could not finish");
    await f.finishFollowup();
    expect(String(f.received[1]!.message.content)).toContain("Review could not finish");
    expect((await f.read()).turns[0]?.backgroundTasks?.[0]?.status).toBe(status === "stopped" ? "cancelled" : "failed");
  });

  it("reserves one attempt despite duplicate terminal events and ignores a late reply from the claimed source", async () => {
    const f = await setup(); f.complete();
    await vi.waitFor(() => expect(f.received).toHaveLength(2), { timeout: 2500 });
    f.complete();
    f.messages.push({ type: "system", subtype: "task_started", task_id: "review", description: "Late start" });
    f.messages.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "review", description: "Stale snapshot" }] });
    f.messages.push(reply(f.received[0]!.uuid, "Late duplicate review result"));
    f.messages.push(result(f.received[0]!.uuid, "Late original result"));
    await f.finishFollowup();
    await vi.waitFor(async () => expect((await f.read()).turns[0]?.backgroundTasks?.[0]?.delivery?.status).toBe("delivered"));
    const saved = await f.read();
    expect(saved.turns).toHaveLength(2);
    expect(saved.messages.some((message) => message.content === "Late duplicate review result")).toBe(false);
    expect(saved.turns[0]?.backgroundTasks?.[0]?.status).toBe("completed");
  });

  it("keeps simultaneous native deliveries from two source turns separate", async () => {
    const f = await setup();
    const second = await f.service.request(scope, "send", { id: f.entry.id, content: "A second background review" });
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    f.messages.push({ type: "system", subtype: "task_started", task_id: "second-review", description: "Second review", is_backgrounded: true });
    f.messages.push(reply(f.received[1]!.uuid, "Second review running."));
    f.messages.push(result(f.received[1]!.uuid, "Second review running."));
    await vi.waitFor(async () => expect((await f.read()).turns[1]?.status).toBe("completed"));
    f.complete();
    f.messages.push({ type: "system", subtype: "task_notification", task_id: "second-review", status: "completed", summary: "Second review done" });
    f.messages.push(reply(undefined, "Ambiguous delivery must not be assigned by last notification"));
    f.messages.push(reply(f.received[0]!.uuid, "First review result"));
    f.messages.push(reply(f.received[1]!.uuid, "Second review result"));
    await vi.waitFor(async () => expect((await f.read()).messages.at(-1)?.content).toBe("Second review result"));
    const saved = await f.read();
    expect(saved.messages.filter((message) => message.content.endsWith("review result")).map((message) => [message.content, message.turnId])).toEqual([["First review result", f.first.turnId], ["Second review result", second.turnId]]);
    expect(f.received).toHaveLength(2);
  });

  it.each([
    { multipleSources: false, streamed: true },
    { multipleSources: true, streamed: true },
    { multipleSources: false, streamed: false },
    { multipleSources: true, streamed: false },
  ].flatMap((scenario) => [true, false].map((endTurn) => ({ ...scenario, endTurn }))))("retains every reply block with sparse UUIDs: %j", async ({ multipleSources, streamed, endTurn }) => {
    const f = await setup();
    let secondTurnId: string | undefined;
    if (multipleSources) {
      secondTurnId = (await f.service.request(scope, "send", { id: f.entry.id, content: "Start another review" })).turnId;
      await vi.waitFor(() => expect(f.received).toHaveLength(2));
      f.messages.push({ type: "system", subtype: "task_started", task_id: "other-review", description: "Other review", is_backgrounded: true });
      f.messages.push(reply(f.received[1]!.uuid, "Other review running."));
      f.messages.push(result(f.received[1]!.uuid, "Other review running."));
      await vi.waitFor(async () => expect((await f.read()).turns[1]?.status).toBe("completed"));
    }
    f.complete();
    if (multipleSources) f.messages.push({ type: "system", subtype: "task_notification", task_id: "other-review", status: "completed", summary: "Other review done" });
    const firstText = "Review result. ";
    const decision = "Decision required: choose topology A or B.";
    // The SDK stamps the source UUID on the first stream frame and first
    // assembled assistant block; subsequent blocks and end frames omit it.
    if (streamed) {
      f.messages.push({ type: "stream_event", user_message_uuid: f.received[0]!.uuid, event: { type: "message_start", message: { id: "review-reply" } } });
      f.messages.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: firstText } } });
    }
    f.messages.push({ type: "assistant", user_message_uuid: f.received[0]!.uuid, message: { id: "review-reply", stop_reason: null, content: [{ type: "text", text: firstText }] } });
    if (streamed) f.messages.push({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: decision } } });
    f.messages.push({ type: "assistant", message: { id: "review-reply", stop_reason: null, content: [{ type: "text", text: decision }] } });
    await new Promise((resolve) => setImmediate(resolve));
    expect((await f.read()).turns[0]?.backgroundTasks?.[0]?.delivery?.status).toBe("pending");
    if (endTurn) f.messages.push({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } });
    else f.messages.push(result(undefined, firstText + decision));
    await vi.waitFor(async () => expect((await f.read()).turns[0]?.backgroundTasks?.[0]?.delivery?.status).toBe("delivered"));
    const saved = await f.read();
    expect(saved.messages.filter((message) => message.turnId === f.first.turnId && message.content.startsWith(firstText)).map((message) => message.content)).toEqual([firstText + decision]);
    if (multipleSources) {
      // The completed stream must not claim unbound frames from the next reply.
      f.messages.push(reply("00000000-0000-4000-8000-000000000000", "Reply for an unrecognized send"));
      f.messages.push({ type: "system", subtype: "task_started", task_id: "third-review", description: "A later review", is_backgrounded: true });
      f.messages.push({ type: "system", subtype: "task_notification", task_id: "third-review", status: "completed", summary: "Later review done" });
      f.messages.push(reply(undefined, "Unbound text after the reply boundary"));
      f.messages.push(reply(f.received[1]!.uuid, "Other review result"));
      f.messages.push(result(f.received[1]!.uuid, "Other review result"));
      await vi.waitFor(async () => expect((await f.read()).messages.at(-1)?.content).toBe("Other review result"));
      expect((await f.read()).messages.at(-1)?.turnId).toBe(secondTurnId);
      expect((await f.read()).messages.some((message) => message.content === "Unbound text after the reply boundary")).toBe(false);
      expect((await f.read()).messages.some((message) => message.content === "Reply for an unrecognized send")).toBe(false);
    }
    expect(f.received).toHaveLength(multipleSources ? 2 : 1);
  });

  it("summarizes two completed tasks from one source in one internal execution", async () => {
    const f = await setup();
    f.messages.push({ type: "system", subtype: "task_started", task_id: "second-review", description: "Second reviewer", is_backgrounded: true });
    f.complete();
    f.messages.push({ type: "system", subtype: "task_notification", task_id: "second-review", status: "completed", summary: "Second reviewer finished" });
    await f.finishFollowup();
    await vi.waitFor(async () => expect((await f.read()).turns[0]?.backgroundTasks?.every((task) => task.delivery?.status === "delivered")).toBe(true));
    expect((await f.read()).turns[1]?.backgroundDelivery?.taskIds).toEqual(["review", "second-review"]);
    expect(f.received).toHaveLength(2);
  });

  it("does not acknowledge another completion that arrived after a native reply began streaming", async () => {
    const f = await setup();
    f.complete();
    f.messages.push({ type: "stream_event", user_message_uuid: f.received[0]!.uuid, event: { type: "content_block_delta", delta: { type: "text_delta", text: "First review result" } } });
    f.messages.push({ type: "system", subtype: "task_started", task_id: "second-review", description: "Second reviewer", is_backgrounded: true });
    f.messages.push({ type: "system", subtype: "task_notification", task_id: "second-review", status: "completed", summary: "Second reviewer finished" });
    f.messages.push({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } });
    await vi.waitFor(async () => expect((await f.read()).messages.at(-1)?.content).toBe("First review result"));
    const tasks = (await f.read()).turns[0]!.backgroundTasks!;
    expect(tasks.find((task) => task.id === "review")?.delivery?.status).toBe("delivered");
    expect(tasks.find((task) => task.id === "second-review")?.delivery?.status).toBe("pending");
    f.messages.push(reply(f.received[0]!.uuid, "Second review result"));
    await vi.waitFor(async () => expect((await f.read()).messages.at(-1)?.content).toBe("Second review result"));
    expect(f.received).toHaveLength(1);
  });

  it("waits for the foreground to finish before a missing native reply is continued", async () => {
    const f = await setup();
    await f.service.request(scope, "send", { id: f.entry.id, content: "New foreground request", model: "fixture-model", permissionMode: "default" });
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    f.complete();
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(f.received).toHaveLength(2);
    f.messages.push(reply(f.received[1]!.uuid, "New foreground result"));
    f.messages.push(result(f.received[1]!.uuid, "New foreground result"));
    await vi.waitFor(() => expect(f.received).toHaveLength(3), { timeout: 2500 });
    expect(f.transport.setPermissionMode).toHaveBeenCalledExactlyOnceWith("default");
    f.messages.push(reply(f.received[2]!.uuid, "Original review summary"));
    f.messages.push(result(f.received[2]!.uuid, "Original review summary"));
    await vi.waitFor(async () => expect((await f.read()).turns[0]?.backgroundTasks?.[0]?.delivery?.status).toBe("delivered"));
    expect((await f.read()).turns[2]?.backgroundDelivery?.sourceTurnId).toBe(f.first.turnId);
  });

  it("delivers into the original conversation while another conversation is selected", async () => {
    const f = await setup();
    const other = await f.service.request(scope, "create", { provider: "claude" });
    await f.service.request(scope, "read", { id: other.id });
    f.complete(); await f.finishFollowup();
    expect((await f.service.request(scope, "read", { id: other.id })).messages).toEqual([]);
    expect(f.notify).toHaveBeenCalledWith(scope, f.entry.id);
  });

  it("reports provider failure during continuation without retrying it", async () => {
    const f = await setup(); f.complete();
    await vi.waitFor(() => expect(f.received).toHaveLength(2), { timeout: 2500 });
    f.messages.push({ ...result(f.received[1]!.uuid, "Fixture provider failed"), is_error: true });
    await vi.waitFor(async () => expect((await f.read()).turns[0]?.backgroundTasks?.[0]?.delivery?.status).toBe("interrupted"));
    expect((await f.read()).messages.at(-1)?.content).toContain("Fixture provider failed");
    expect(f.received).toHaveLength(2);
  });

  it("checks a pause again after asynchronous context preparation", async () => {
    const f = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.prepareContext.mockImplementationOnce(async () => { await gate; return { env: {}, systemPrompt: "Refreshed scoped context", dispose: vi.fn(async () => {}) }; });
    try {
      f.complete();
      await vi.waitFor(() => expect(f.prepareContext).toHaveBeenCalledTimes(2), { timeout: 2500 });
      await f.service.request(scope, "queueUpdate", { id: f.entry.id, action: "pause" });
      release();
      await vi.waitFor(async () => expect((await f.read()).turns[0]?.backgroundTasks?.[0]?.delivery?.status).toBe("interrupted"));
      expect(f.received).toHaveLength(1);
    } finally { release(); }
  });

  it("keeps a decision question in the internal execution pending until the user answers", async () => {
    const f = await setup(); f.complete();
    await vi.waitFor(() => expect(f.received).toHaveLength(2), { timeout: 2500 });
    const [, signal, current] = f.prepareContext.mock.calls[1]!;
    const answer = current.askUser!({ request_id: "followup-decision", questions: [{ id: "choice", question: "Which result should be applied?", options: [{ label: "First" }, { label: "Second" }], multiSelect: false, allowFreeText: false }] }, signal);
    const internalId = (await f.read()).turns[1]!.id;
    await vi.waitFor(async () => expect((await f.read()).turns[1]?.questions?.[0]?.status).toBe("pending"));
    expect((await f.read()).turns[0]?.status).toBe("completed");
    await f.service.request(scope, "answerQuestion", { id: f.entry.id, turnId: internalId, requestId: "followup-decision", answers: { choice: "First" } });
    expect(await answer).toEqual({ answersByQuestionId: { choice: "First" } });
    await f.finishFollowup();
  });

  it.each(["pending", "requested"])("does not replay a %s delivery after an unexpected restart", async (status) => {
    const f = await setup(); f.complete();
    await vi.waitFor(async () => expect((await f.read()).turns[0]?.backgroundTasks?.[0]?.delivery?.status).toBe(status), { timeout: 2500 });
    await f.service.flush();
    const directory = (await readdir(f.options.root)).find((name) => name.length === 64)!;
    const dir = join(f.options.root, directory);
    const path = join(dir, "index.json");
    const atCrash = await readFile(path, "utf8");
    const details = await Promise.all(JSON.parse(atCrash).sessions.map(async (item: { file: string }) => ({ file: item.file, content: await readFile(join(dir, "details", item.file), "utf8") })));
    await f.service.stop();
    // Restore the committed index and its detail versions from before shutdown.
    for (const detail of details) await writeFile(join(dir, "details", detail.file), detail.content);
    await writeFile(path, atCrash);
    const reopened = new LocalConversationService(f.options); reopened.setCurrentUser(scope.userId);
    cleanups.push(() => reopened.stop());
    const saved = await reopened.request(scope, "read", { id: f.entry.id });
    expect(saved.turns[0]?.backgroundTasks?.[0]?.delivery?.status).toBe("interrupted");
    expect(saved.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(f.query).toHaveBeenCalledOnce();
  });

  it("does not automatically execute a paused conversation and persists that decision through reopening", async () => {
    const f = await setup();
    await f.service.request(scope, "queueUpdate", { id: f.entry.id, action: "pause" });
    f.complete();
    await vi.waitFor(async () => expect((await f.read()).turns[0]?.backgroundTasks?.[0]?.delivery?.status).toBe("interrupted"), { timeout: 2500 });
    expect(f.received).toHaveLength(1);
    expect((await f.read()).messages.at(-1)?.content).toContain("Review finished");
    await f.service.stop();
    const reopened = new LocalConversationService(f.options); reopened.setCurrentUser(scope.userId);
    cleanups.push(() => reopened.stop());
    const saved = await reopened.request(scope, "read", { id: f.entry.id });
    expect(saved.promptQueue?.paused).toBe(true);
    expect(saved.turns[0]?.backgroundTasks?.[0]?.delivery?.status).toBe("interrupted");
    expect(f.query).toHaveBeenCalledOnce();
  });

  it("reports an explicit stop without starting a model to continue stopped work", async () => {
    const f = await setup();
    f.transport.stopTask.mockImplementationOnce(async () => {
      f.complete("stopped", "User stopped the reviewer");
      await new Promise((resolve) => setImmediate(resolve));
    });
    await f.service.request(scope, "stopBackgroundTasks", { id: f.entry.id });
    await vi.waitFor(async () => expect((await f.read()).turns[0]?.backgroundTasks?.[0]?.delivery?.status).toBe("interrupted"), { timeout: 2500 });
    expect(f.transport.stopTask).toHaveBeenCalledExactlyOnceWith("review");
    expect(f.received).toHaveLength(1);
    expect((await f.read()).messages.at(-1)?.content).toContain("cancelled");
  });

  it("uses a later terminal update to resolve an unconfirmed snapshot outcome", async () => {
    const f = await setup();
    f.messages.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    f.messages.push({ type: "system", subtype: "task_updated", task_id: "review", patch: { status: "failed", error: "Review failed after snapshot" } });
    await f.finishFollowup();
    expect(String(f.received[1]!.message.content)).toContain("Review failed after snapshot");
    expect((await f.read()).turns[0]?.backgroundTasks?.[0]).toMatchObject({ status: "failed", completionSource: "update", delivery: { status: "delivered" } });
  });

  it.each(["logout", "shutdown"])("does not start follow-up work after %s", async (action) => {
    const f = await setup(); f.complete();
    await vi.waitFor(async () => expect((await f.read()).turns[0]?.backgroundTasks?.[0]?.status).toBe("completed"));
    if (action === "logout") f.service.setCurrentUser("another-user");
    else await f.service.stop();
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(f.received).toHaveLength(1);
  });
});
