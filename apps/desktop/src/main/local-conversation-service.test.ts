// @vitest-environment node
import type { LocalTimingRecord } from "@multica/tutti-agent-gui-host/local-timing";
import { LOCAL_CONVERSATION_METHODS, LOCAL_CONVERSATION_PROTOCOL_VERSION } from "@multica/tutti-agent-gui-host/local-protocol";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalConversationService } from "./local-conversation-service";
import type { runLocalProvider } from "./local-provider-runner";
import type { LocalExecutionContext } from "./local-multica-context";
import type { forkLocalProvider } from "./local-provider-fork";
import { ForkBoundaryUnavailable } from "./local-provider-fork";
import { LocalClaudeConversation, type ClaudeRunObserver } from "./local-claude-conversation";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const scope = { userId: "user", workspaceId: "workspace" };
async function setup(run: typeof runLocalProvider = async () => ({ output: "Reply", sessionId: "native-thread" }), prepareContext?: (currentScope: typeof scope, signal: AbortSignal) => Promise<LocalExecutionContext>) {
  const root = await mkdtemp(join(tmpdir(), "multica-local-conversations-"));
  const usage = { read: vi.fn(async () => ({ provider: "claude" as const, context: { usedTokens: 120, limitTokens: 1000, model: null, updatedAt: null }, account: { status: "unavailable" as const, plan: null, windows: [], updatedAt: null } })), reset: vi.fn() };
  const options = { timing: vi.fn<(record: LocalTimingRecord) => void>(), root, apiUrl: "https://example.test", notify: vi.fn(), chooseDirectory: vi.fn(async () => "/selected-directory"), find: vi.fn(async () => "/test-owned/fake-cli"), run: vi.fn(run), fork: vi.fn<typeof forkLocalProvider>(async () => "native-branch"), usage, prepareContext };
  const service = new LocalConversationService(options); service.setCurrentUser(scope.userId);
  cleanups.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { service, options };
}
describe("local conversation persistence and execution", () => {
  it("persists thinking effort, forwards it to execution, inherits it in forks and resets on model changes", async () => {
    const { service, options } = await setup();
    const entry = await service.request(scope, "create", { provider: "codex" });
    const first = await service.request(scope, "send", { id: entry.id, content: "hello", model: "model-a", reasoningEffort: "high" });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalled());
    expect(options.run.mock.calls[0]?.[0]).toMatchObject({ model: "model-a", reasoningEffort: "high" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[0]?.status).toBe("completed"));
    const fork = await service.request(scope, "fork", { id: entry.id, turnId: first.turnId });
    expect(fork).toMatchObject({ reasoningEffort: "high" });
    await service.request(scope, "send", { id: entry.id, content: "next", model: "model-b" });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledTimes(2));
    expect(options.run.mock.calls[1]?.[0]).toMatchObject({ model: "model-b", reasoningEffort: null });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns.at(-1)?.status).toBe("completed"));
    await service.stop();
    const restarted = new LocalConversationService(options); restarted.setCurrentUser(scope.userId);
    cleanups.unshift(() => restarted.stop());
    expect(await restarted.request(scope, "read", { id: fork.id })).toMatchObject({ reasoningEffort: "high" });
    expect(await restarted.request(scope, "read", { id: entry.id })).toMatchObject({ reasoningEffort: null });
  });
  it("previews a selected external file without granting its siblings or another workspace access", async () => {
    const { service, options } = await setup();
    const entry = await service.request(scope, "create", { provider: "claude" });
    const path = join(options.root, "runtime_mcp.go");
    await writeFile(path, "package daemon");
    await expect(service.request(scope, "previewRead", { path, id: entry.id })).rejects.toThrow("Choose this folder");
    Object.assign(options, { choosePreview: async () => path });
    const location = await service.request(scope, "previewChoose", { kind: "file" });
    expect(await service.request(scope, "previewRead", { path, id: entry.id })).toMatchObject({ root: location!.root, path: location!.path, text: "package daemon" });
    await expect(service.request({ ...scope, workspaceId: "other" }, "previewRead", { path })).rejects.toThrow("Choose this folder");
  });
  it("uses the pool only for Codex dialogue turns and closes it on account change and shutdown", async () => {
    const { service, options } = await setup();
    const pools: { run: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
    const factory = vi.fn(() => {
      const pool = { run: vi.fn(async () => ({ output: "Pooled reply", sessionId: "pooled-thread" })), stop: vi.fn(async () => {}) };
      pools.push(pool); return pool;
    });
    Object.assign(options, { codexPool: factory });
    const codex = await service.request(scope, "create", { provider: "codex" });
    const claude = await service.request(scope, "create", { provider: "claude" });
    await service.request(scope, "send", { id: codex.id, content: "First turn" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: codex.id })).turns[0]?.status).toBe("completed"));
    await service.request(scope, "send", { id: codex.id, content: "Continue" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: codex.id })).turns[1]?.status).toBe("completed"));
    expect(factory).toHaveBeenCalledOnce(); expect(pools[0]!.run).toHaveBeenCalledTimes(2);
    expect(pools[0]!.run.mock.calls[1]![1]).toMatchObject({ resume: "pooled-thread" });
    expect(options.run).not.toHaveBeenCalled();
    await service.request(scope, "send", { id: claude.id, content: "Claude stays on its current runner" });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
    expect(pools[0]!.run).toHaveBeenCalledTimes(2);
    service.setCurrentUser("another-user"); expect(pools[0]!.stop).toHaveBeenCalledOnce();
    const nextScope = { ...scope, userId: "another-user" };
    const next = await service.request(nextScope, "create", { provider: "codex" });
    await service.request(nextScope, "send", { id: next.id, content: "New account" });
    await vi.waitFor(async () => expect((await service.request(nextScope, "read", { id: next.id })).turns[0]?.status).toBe("completed"));
    expect(factory).toHaveBeenCalledTimes(2);
    await service.stop(); expect(pools[1]!.stop).toHaveBeenCalledOnce();
  });
  it("correlates concurrent turn stages and preserves request behavior without logging content", async () => {
    const { service, options } = await setup(async (input, emit) => {
      input.onSessionId?.("fake-native-session");
      emit({ type: "text", content: "PRIVATE_REPLY" });
      emit({ type: "text", content: "PRIVATE_REPLY_2" });
      return { output: "PRIVATE_REPLY" };
    }, async () => ({ env: { TOKEN: "PRIVATE_TOKEN" }, systemPrompt: "PRIVATE_PROMPT", dispose: async () => {} }));
    const a = await service.request(scope, "create", { provider: "codex" });
    const b = await service.request(scope, "create", { provider: "claude" });
    const accepted = await Promise.all([a, b].map((entry, i) => service.request(scope, "send", { id: entry.id, requestId: `request-${i}`, content: "PRIVATE_INPUT" })));
    await vi.waitFor(() => expect(options.timing.mock.calls.filter(([r]) => r.stage === "turn.finished")).toHaveLength(2));
    for (const [i, reply] of accepted.entries()) {
      const records = options.timing.mock.calls.map(([r]) => r).filter((r) => r.turnId === reply.turnId);
      expect(records.every((r) => r.requestId === `request-${i}` && r.conversationId === [a, b][i]!.id)).toBe(true);
      expect(records.map((r) => r.stage)).toEqual(expect.arrayContaining(["turn.persist", "context.prepare", "provider.session_ready", "provider.first_output", "provider.first_text", "images.recover", "turn.save", "turn.finished"]));
      expect(records.filter((r) => r.stage === "provider.first_text")).toHaveLength(1);
      expect(records.at(-1)).toMatchObject({ outcome: "completed" });
    }
    expect(JSON.stringify(options.timing.mock.calls)).not.toContain("PRIVATE_");
  });
  it("records preparation failures and terminates their timing span", async () => {
    const { service, options } = await setup(undefined, async () => { throw new Error("fetch failed PRIVATE_TOKEN"); });
    const entry = await service.request(scope, "create", { provider: "codex" });
    await service.request(scope, "send", { id: entry.id, content: "hello", requestId: "failed-request" });
    await vi.waitFor(() => expect(options.timing.mock.calls.some(([r]) => r.stage === "turn.finished")).toBe(true));
    expect(options.run).not.toHaveBeenCalled();
    expect(options.timing.mock.calls.map(([r]) => r)).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "context.prepare", event: "end", outcome: "failed", failure: "transport" }),
      expect.objectContaining({ stage: "turn.finished", outcome: "failed" }),
    ]));
    expect(JSON.stringify(options.timing.mock.calls)).not.toContain("PRIVATE_TOKEN");

  });
  it("advertises supported IPC methods with the same account scope as conversation reads", async () => {
    const { service, options } = await setup();
    expect(await service.request(scope, "capabilities", {})).toEqual({ protocolVersion: LOCAL_CONVERSATION_PROTOCOL_VERSION, methods: Object.keys(LOCAL_CONVERSATION_METHODS) });
    expect(options.run).not.toHaveBeenCalled();
    await expect(service.request({ ...scope, userId: "other" }, "capabilities", {})).rejects.toThrow();
  });
  it.each(["codex", "claude"] as const)("passes saved image paths to new and resumed %s turns without carrying attachments into unrelated messages", async (provider) => {
    const { service, options } = await setup();
    const image = Buffer.from("test-owned image bytes");
    const stored = await service.request(scope, "fileStore", { name: "screenshot.png", mimeType: "image/png", data: image.toString("base64") });
    const file = await service.request(scope, "fileRead", stored);
    const entry = await service.request(scope, "create", { provider });
    for (const attached of [true, false, true]) {
      await service.request(scope, "send", { id: entry.id, content: "Describe the attachment", ...(attached ? { attachmentIds: [stored.id] } : {}) });
      await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns.at(-1)?.status).toBe("completed"));
      const input = options.run.mock.calls.at(-1)?.[0];
      expect(input).not.toHaveProperty("images");
      expect(input?.content.includes(file.path)).toBe(attached);
      expect(input?.content).not.toContain(image.toString("base64"));
      if (attached) expect(input?.content).toContain("image viewing tool");
    }
    expect(options.run.mock.calls[2]?.[0].resume).toBe("native-thread");
    const saved = await service.request(scope, "read", { id: entry.id });
    expect(saved.messages.filter((message) => message.role === "user").map((message) => message.attachmentIds)).toEqual([[stored.id], undefined, [stored.id]]);
  });
  it("persists a completed foreground reply separately from live background tasks and accepts the next Claude message", async () => {
    const disposeContext = vi.fn(async () => {});
    const { service, options } = await setup(undefined, async () => ({ env: {}, systemPrompt: "Scoped context", dispose: disposeContext }));
    const observers: ClaudeRunObserver[] = [];
    let close!: () => Promise<void>;
    const worker = { available: true, signal: new AbortController().signal,
      run: vi.fn(async (_input, _emit, _signal, observer: ClaudeRunObserver) => {
        observers.push(observer);
        if (observers.length === 1) observer.tasks([{ id: "watcher", description: "Wait for PR", status: "running" }]);
        return { output: `Reply ${observers.length}`, sessionId: "same-native-conversation" };
      }),
      stop: vi.fn(async () => { worker.available = false; observers[0]?.tasks([{ id: "watcher", description: "Wait for PR", status: "cancelled" }]); await close(); }),
      stopBackground: vi.fn(async () => { observers[0]?.tasks([{ id: "watcher", description: "Wait for PR", status: "cancelled" }]); }),
    };
    const factory = vi.fn((onClose: () => Promise<void>) => { close = onClose; return worker as unknown as LocalClaudeConversation; });
    Object.assign(options, { claudeConversation: factory });
    const entry = await service.request(scope, "create", { provider: "claude" });
    const first = await service.request(scope, "send", { id: entry.id, content: "Watch this PR" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[0]?.status).toBe("completed"));
    const list = await service.request(scope, "list", {});
    expect(list[0]?.turns[0]).toMatchObject({ status: "completed", backgroundTasks: [{ id: "watcher", status: "running" }] });
    expect(disposeContext).not.toHaveBeenCalled();
    await service.request(scope, "send", { id: entry.id, content: "Continue now" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[1]?.status).toBe("completed"));
    expect(factory).toHaveBeenCalledOnce(); expect(worker.run).toHaveBeenCalledTimes(2); expect(options.run).not.toHaveBeenCalled();
    expect(worker.run.mock.calls[1]?.[0]).toMatchObject({ resume: "same-native-conversation", content: "Continue now" });
    observers[0]!.reply("The PR has merged.");
    const saved = await service.request(scope, "read", { id: entry.id });
    expect(saved.messages.at(-1)).toMatchObject({ role: "assistant", content: "The PR has merged.", turnId: first.turnId });
    expect(saved.turns[1]?.backgroundTasks).toBeUndefined();
    await service.request(scope, "stopBackgroundTasks", { id: entry.id });
    expect(worker.stopBackground).toHaveBeenCalledOnce(); expect(worker.stop).not.toHaveBeenCalled(); expect(disposeContext).not.toHaveBeenCalled();
    expect((await service.request(scope, "list", {}))[0]?.turns).toEqual([]);
    expect((await service.request(scope, "read", { id: entry.id })).turns[0]?.status).toBe("completed");
    await service.stop(); expect(disposeContext).toHaveBeenCalledTimes(2);
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId); cleanups.push(() => reopened.stop());
    const restored = await reopened.request(scope, "read", { id: entry.id });
    expect(restored.messages.at(-1)?.content).toBe("The PR has merged.");
    expect(restored.turns[0]?.backgroundTasks?.[0]?.status).toBe("cancelled");
  });
  it("marks saved background tasks stopped after a restart without replaying their commands", async () => {
    const { service, options } = await setup(); const entry = await service.request(scope, "create", { provider: "claude" });
    await service.request(scope, "send", { id: entry.id, content: "Saved request" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[0]?.status).toBe("completed"));
    await service.stop();
    const folders = await readdir(options.root); const path = join(options.root, folders.find((folder) => folder.length === 64)!, "conversations.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved.sessions[0].turns[0].backgroundTasks = [{ id: "old-watcher", description: "Old monitor", status: "running" }];
    await writeFile(path, JSON.stringify(saved)); options.run.mockClear();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId); cleanups.push(() => reopened.stop());
    const restored = await reopened.request(scope, "read", { id: entry.id });
    expect(restored.turns[0]).toMatchObject({ status: "completed", backgroundTasks: [{ id: "old-watcher", status: "cancelled" }] });
    expect((await reopened.request(scope, "list", {}))[0]?.turns).toEqual([]); expect(options.run).not.toHaveBeenCalled();
  });
  it.each(["codex", "claude"] as const)("persists %s permissions per conversation, resumes them and carries them to a Side", async (provider) => {
    const { service, options } = await setup();
    const entry = await service.request(scope, "create", { provider });
    await service.request(scope, "send", { id: entry.id, content: "Use automatic approval", permissionMode: "auto" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns.at(-1)?.status).toBe("completed"));
    await service.request(scope, "send", { id: entry.id, content: "Continue with the same permissions" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns.at(-1)?.status).toBe("completed"));
    expect(options.run.mock.calls.map(([input]) => input.permissionMode)).toEqual(["auto", "auto"]);
    const side = await service.request(scope, "sideCreate", { id: entry.id, requestId: "permission-side" });
    expect(side.permissionMode).toBe("auto");
    await service.request(scope, "send", { id: entry.id, content: "Return to local defaults", permissionMode: "default" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns.at(-1)?.status).toBe("completed"));
    expect(options.run.mock.calls.at(-1)?.[0].permissionMode).toBe("default");
    const other = await service.request(scope, "create", { provider });
    expect(other.permissionMode).toBeUndefined();
    const restarted = new LocalConversationService(options); restarted.setCurrentUser(scope.userId);
    cleanups.unshift(async () => restarted.stop());
    expect((await restarted.request(scope, "read", { id: entry.id })).permissionMode).toBe("default");
    expect((await restarted.request(scope, "read", { id: side.id })).permissionMode).toBe("auto");
  });
  it("rejects invalid permission modes before saving a user turn or invoking a provider", async () => {
    const { service, options } = await setup();
    const entry = await service.request(scope, "create", { provider: "codex" });
    await expect(service.request(scope, "send", { id: entry.id, content: "Invalid permissions", permissionMode: "unknown" as never })).rejects.toThrow("Invalid permission mode");
    expect(options.run).not.toHaveBeenCalled();
    expect((await service.request(scope, "read", { id: entry.id })).turns).toEqual([]);
  });
  it("does not record a Side submission as accepted when saving fails before execution", async () => {
    const { service, options } = await setup(); const source = await service.request(scope, "create", { provider: "codex" });
    const requestId = `side:${source.id}:recovery`;
    const side = await service.request(scope, "sideCreate", { id: source.id, requestId, pending: { requestId, content: "Recover this queued message" } });
    const root = options.root; const blocked = join(root, "not-a-directory"); await writeFile(blocked, "blocked"); options.root = blocked;
    await expect(service.request(scope, "send", { id: side.id, requestId, content: "Recover this queued message" })).rejects.toThrow();
    expect(options.run).not.toHaveBeenCalled(); expect((await service.request(scope, "read", { id: side.id })).turns).toHaveLength(0);
    options.root = root;
    await service.request(scope, "send", { id: side.id, requestId, content: "Recover this queued message" });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
  });
  it.each(["codex", "claude"] as const)("keeps a %s side snapshot independent from later source messages and resumes its own session", async (provider) => {
    const { service, options } = await setup(async (input) => ({ output: "Reply", sessionId: input.resume ?? (input.content.includes("independent Multica side") ? "side-native" : "source-native") }));
    const source = await service.request(scope, "create", { provider });
    const first = await service.request(scope, "send", { id: source.id, content: "SOURCE_BEFORE" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: source.id })).turns[0]?.status).toBe("completed"));
    const side = await service.request(scope, "sideCreate", { id: source.id, turnId: first.turnId, quote: "SOURCE_BEFORE", requestId: "selection-side" });
    expect(side.messages).toEqual([]); expect(side.providerSessionId).toBeUndefined(); expect(side.side?.context).toHaveLength(2);
    await service.request(scope, "send", { id: source.id, content: "SOURCE_FUTURE" });
    await service.request(scope, "send", { id: side.id, content: "Side question" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: side.id })).turns[0]?.status).toBe("completed"));
    const input = options.run.mock.calls.find(([input]) => input.content.includes("independent Multica side"))![0];
    expect(input.resume).toBeUndefined(); expect(input.content).toContain("SOURCE_BEFORE"); expect(input.content).not.toContain("SOURCE_FUTURE");
    expect((await service.request(scope, "read", { id: side.id })).messages.map((message) => message.content)).toEqual(["Side question", "Reply"]);
    await service.request(scope, "send", { id: side.id, content: "Follow up" });
    await vi.waitFor(() => expect(options.run).toHaveBeenLastCalledWith(expect.objectContaining({ resume: "side-native", content: "Follow up" }), expect.any(Function), expect.any(AbortSignal)));
  });
  it("durably transfers queue ownership, rejects source replay, and accepts the side submission only once", async () => {
    const { service, options } = await setup();
    const source = await service.request(scope, "create", { provider: "codex" });
    const requestId = `side:${source.id}:queued-1`;
    const side = await service.request(scope, "sideCreate", { id: source.id, requestId, pending: { content: "Queued message", requestId } });
    expect((await service.request(scope, "sideCreate", { id: source.id, requestId })).id).toBe(side.id);
    await expect(service.request(scope, "send", { id: source.id, requestId: "queued-1", content: "Queued message" })).rejects.toThrow("moved to a side");
    const sent = await service.request(scope, "send", { id: side.id, requestId, content: "Queued message" });
    expect(await service.request(scope, "send", { id: side.id, requestId, content: "Queued message" })).toMatchObject({ ...sent, replayed: true });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
    await service.request(scope, "sideAccepted", { id: side.id, requestId });
    expect((await service.request(scope, "read", { id: side.id })).side?.pending).toBeUndefined();
    await service.stop(); const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId);
    try { expect((await reopened.request(scope, "read", { id: side.id })).side?.sourceId).toBe(source.id); await expect(reopened.request(scope, "send", { id: source.id, requestId: "queued-1", content: "Queued message" })).rejects.toThrow("moved to a side"); }
    finally { await reopened.stop(); }
  });
  it.each(["codex", "claude"] as const)("forks %s at an earlier turn, retains lineage after restart, and never includes later messages", async (provider) => {
    const { service, options } = await setup(async (input) => ({ output: `Reply to ${input.content}`, sessionId: input.resume ?? "source-native" }));
    const source = await service.request(scope, "create", { provider, projectId: "project" });
    for (const content of ["First", "Second", "FUTURE_SECRET"]) {
      await service.request(scope, "send", { id: source.id, content, model: "chosen" });
      await vi.waitFor(async () => expect((await service.request(scope, "read", { id: source.id })).turns.at(-1)?.status).toBe("completed"));
    }
    const before = await service.request(scope, "read", { id: source.id });
    const branch = await service.request(scope, "fork", { id: source.id, turnId: before.turns[1]!.id, requestId: "fork-at-second" });
    expect(branch).toMatchObject({ forkedFrom: source.id, forkedFromTurnId: before.turns[1]!.id, forkMode: "native", providerSessionId: "native-branch", projectId: "project", model: "chosen" });
    expect(branch.messages.map((message) => message.content)).toEqual(before.messages.slice(0, 4).map((message) => message.content));
    expect(branch.turns).toHaveLength(2);
    expect(branch.forkedTurnId).toBe(branch.turns[1]!.id);
    expect(options.fork).toHaveBeenCalledWith(expect.objectContaining({ through: { index: 1, prompts: ["First", "Second", "FUTURE_SECRET"] } }), expect.any(AbortSignal));
    expect(await service.request(scope, "read", { id: source.id })).toEqual(before);
    expect((await service.request(scope, "fork", { id: source.id, turnId: before.turns[1]!.id, requestId: "fork-at-second" })).id).toBe(branch.id);
    expect(options.fork).toHaveBeenCalledOnce();
    await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId);
    try {
      const restored = await reopened.request(scope, "read", { id: branch.id });
      expect(restored).toMatchObject({ id: branch.id, forkedFrom: source.id, forkedFromTurnId: before.turns[1]!.id, forkMode: "native", providerSessionId: "native-branch" });
      expect(restored.messages).toEqual(JSON.parse(JSON.stringify(branch.messages)));
      await reopened.request(scope, "send", { id: branch.id, content: "Continue", model: "chosen" });
      await vi.waitFor(() => expect(options.run).toHaveBeenLastCalledWith(expect.objectContaining({ resume: "native-branch", content: "Continue" }), expect.any(Function), expect.any(AbortSignal)));
    } finally { await reopened.stop(); }
  });
  it.each(["codex", "claude"] as const)("starts an independent %s context when an old turn has no reliable native binding", async (provider) => {
    const { service, options } = await setup();
    const source = await service.request(scope, "create", { provider });
    for (const content of ["BEFORE_BOUNDARY", "AFTER_BOUNDARY"]) {
      await service.request(scope, "send", { id: source.id, content });
      await vi.waitFor(async () => expect((await service.request(scope, "read", { id: source.id })).turns.at(-1)?.status).toBe("completed"));
    }
    const before = await service.request(scope, "read", { id: source.id });
    options.fork.mockRejectedValueOnce(new ForkBoundaryUnavailable("No binding"));
    const branch = await service.request(scope, "fork", { id: source.id, turnId: before.turns[0]!.id });
    expect(branch.forkMode).toBe("saved-context"); expect(branch.providerSessionId).toBeUndefined();
    options.run.mockImplementation(async () => ({ output: "Branch reply", sessionId: "fresh-native" }));
    await service.request(scope, "send", { id: branch.id, content: "Continue here" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: branch.id })).turns.at(-1)?.status).toBe("completed"));
    const input = options.run.mock.calls.at(-1)![0];
    expect(input.resume).toBeUndefined(); expect(input.content).toContain("BEFORE_BOUNDARY"); expect(input.content).not.toContain("AFTER_BOUNDARY");
    expect(input.content).toContain("Current user request:\nContinue here");
    expect((await service.request(scope, "read", { id: branch.id })).messages.at(-2)?.content).toBe("Continue here");
    expect(await service.request(scope, "read", { id: source.id })).toEqual(before);
    await service.request(scope, "send", { id: branch.id, content: "Again" });
    await vi.waitFor(() => expect(options.run).toHaveBeenLastCalledWith(expect.objectContaining({ resume: "fresh-native", content: "Again" }), expect.any(Function), expect.any(AbortSignal)));
  });
  it("forks official-agent turns with saved results, and rejects running or unrelated boundaries", async () => {
    const { service, options } = await setup();
    const source = await service.request(scope, "create", { provider: "codex" });
    const sent = await service.request(scope, "remoteBegin", { id: source.id, content: "Review", agents: [{ id: "reviewer", name: "Reviewer" }] });
    await expect(service.request(scope, "fork", { id: source.id, turnId: sent.turns[0]!.id })).rejects.toThrow("selected execution");
    await expect(service.request(scope, "fork", { id: source.id, turnId: "other-turn" })).rejects.toThrow("not found");
    await service.request(scope, "remoteUpdate", { id: source.id, turnId: sent.turns[0]!.id, output: "REVIEW_RESULT", status: "completed" });
    const branch = await service.request(scope, "fork", { id: source.id, turnId: sent.turns[0]!.id });
    expect(branch.forkMode).toBe("saved-context"); expect(options.fork).not.toHaveBeenCalled();
    expect(branch.messages.at(-1)?.content).toBe("REVIEW_RESULT"); expect(branch.turns[0]?.remote).toEqual({ agentId: "reviewer", agentName: "Reviewer" });
  });
  it("forks an earlier settled turn while a later turn keeps running in the source", async () => {
    let finish!: (value: { output: string; sessionId: string }) => void;
    const { service } = await setup(async (input) => input.content === "Later running" ? new Promise((resolve) => { finish = resolve; }) : { output: "Earlier reply", sessionId: "source-native" });
    const source = await service.request(scope, "create", { provider: "codex" });
    const first = await service.request(scope, "send", { id: source.id, content: "Earlier" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: source.id })).turns[0]?.status).toBe("completed"));
    await service.request(scope, "send", { id: source.id, content: "Later running" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    try {
      const branch = await service.request(scope, "fork", { id: source.id, turnId: first.turnId });
      expect(branch.turns).toHaveLength(1); expect(branch.messages.map((message) => message.content)).toEqual(["Earlier", "Earlier reply"]);
      expect((await service.request(scope, "read", { id: source.id })).turns.at(-1)?.status).toBe("running");
    } finally { finish({ output: "Later reply", sessionId: "source-native" }); }
  });
  it("cuts later parallel agent results and tool events, and records the remapped selected turn", async () => {
    const { service } = await setup();
    const source = await service.request(scope, "create", { provider: "codex" });
    const sent = await service.request(scope, "remoteBegin", { id: source.id, content: "Review", agents: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
    const [a, b] = sent.turns;
    await service.request(scope, "remoteUpdate", { id: source.id, turnId: b!.id, output: "B replied first", status: "completed" });
    await service.request(scope, "remoteUpdate", { id: source.id, turnId: a!.id, output: "A replied later", status: "completed", events: [{ seq: 1, type: "tool_result", output: "FUTURE_TOOL_SECRET", created_at: "2099-01-01T00:00:00Z" }] });
    const branch = await service.request(scope, "fork", { id: source.id, turnId: b!.id });
    expect(JSON.stringify(branch)).not.toContain("A replied later"); expect(JSON.stringify(branch)).not.toContain("FUTURE_TOOL_SECRET");
    const throughA = await service.request(scope, "fork", { id: source.id, turnId: a!.id });
    expect(throughA.forkedTurnId).toBe(throughA.turns[0]!.id);
    expect((await service.request(scope, "read", { id: source.id })).turns[0]!.events[0]!.output).toBe("FUTURE_TOOL_SECRET");
  });
  it.each(["codex", "claude"] as const)("supplies HTML and SVG preview capabilities to new and resumed %s conversations", async (provider) => {
    const { service, options } = await setup();
    const entry = await service.request(scope, "create", { provider });
    for (const content of ["Show an interactive chart", "Adjust its labels"]) {
      await service.request(scope, "send", { id: entry.id, content });
      await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns.at(-1)?.status).toBe("completed"));
    }
    expect(options.run).toHaveBeenCalledTimes(2);
    for (const [input] of options.run.mock.calls) {
      expect(input.systemPrompt).toContain("fenced code block with the language html");
      expect(input.systemPrompt).toContain("Chart.js 4 (global Chart) and D3 7 (global d3)");
      expect(input.systemPrompt).toContain("fenced code block with the language svg");
      expect(input.systemPrompt).toContain("Return the markup itself in your assistant reply");
      expect(input.systemPrompt).toContain("SVG previews support zoom, fit, source view and copying");
      expect(input.systemPrompt).toContain("For flowcharts and workflow/process diagrams, default to a self-contained SVG");
      expect(input.systemPrompt).toContain("unless the user explicitly requests another format");
      expect(input.systemPrompt).toContain("no access to the host application");
    }
    expect(options.run.mock.calls[0]![0]).toMatchObject({ provider, content: "Show an interactive chart" });
    expect(options.run.mock.calls[1]![0]).toMatchObject({ resume: "native-thread", content: "Adjust its labels" });
    await service.flush();
    const [folder] = await readdir(options.root);
    expect(await readFile(join(options.root, folder!, "conversations.json"), "utf8")).not.toContain("Multica's conversation panel can render");
  });
  it("persists project moves and clearing without changing native history or working directory", async () => {
    const { service, options } = await setup();
    const entry = await service.request(scope, "create", { provider: "codex", projectId: "project-a" });
    await service.request(scope, "send", { id: entry.id, content: "Remember" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[0]?.status).toBe("completed"));
    const before = await service.request(scope, "read", { id: entry.id });
    const moved = await service.request(scope, "update", { id: entry.id, projectId: "project-b" });
    expect(moved).toMatchObject({ projectId: "project-b", cwd: before.cwd, providerSessionId: before.providerSessionId, messages: before.messages, turns: before.turns });
    await expect(service.request(scope, "update", { id: entry.id, projectId: " " })).rejects.toThrow("Invalid project");
    expect((await service.request(scope, "read", { id: entry.id })).projectId).toBe("project-b");
    await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId);
    try {
      expect((await reopened.request(scope, "read", { id: entry.id })).projectId).toBe("project-b");
      expect((await reopened.request(scope, "update", { id: entry.id, projectId: null })).projectId).toBeNull();
      expect(options.run).toHaveBeenCalledOnce();
    } finally { await reopened.stop(); }
  });
  it.each(["codex", "claude"] as const)("forks %s native context, isolates history and resumes the branch after reopening", async (provider) => {
    const { service, options } = await setup(async (input) => ({ output: "Reply", sessionId: input.resume ?? "native-thread" }));
    const source = await service.request(scope, "create", { provider, projectId: "project-a" });
    await service.request(scope, "send", { id: source.id, content: "Remember this", model: "chosen-model" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: source.id })).turns[0]?.status).toBe("completed"));
    const remote = await service.request(scope, "remoteBegin", { id: source.id, content: "Review", agents: [{ id: "reviewer", name: "Reviewer" }] });
    await service.request(scope, "remoteUpdate", { id: source.id, turnId: remote.turns[0]!.id, sessionId: "official-source", taskId: "official-task", status: "completed", output: "Review result" });
    await service.request(scope, "update", { id: source.id, pinned: true, archived: true });
    const before = await service.request(scope, "read", { id: source.id });
    const branch = await service.request(scope, "fork", { id: source.id });
    expect(options.fork).toHaveBeenCalledWith({ provider, sessionId: "native-thread", cwd: source.cwd, title: branch.title }, expect.any(AbortSignal));
    expect(branch).toMatchObject({ forkedFrom: source.id, providerSessionId: "native-branch", cwd: source.cwd, provider, model: "chosen-model", pinned: false, archived: false, projectId: "project-a" });
    expect(branch.id).not.toBe(source.id);
    expect(branch.messages.map((message) => message.content)).toEqual(before.messages.map((message) => message.content));
    expect(branch.messages.every((message) => !before.messages.some((original) => original.id === message.id) && branch.turns.some((turn) => turn.id === message.turnId))).toBe(true);
    expect(branch.turns[1]?.remote).toEqual({ agentId: "reviewer", agentName: "Reviewer" });
    expect(await service.request(scope, "read", { id: source.id })).toEqual(before);
    await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId);
    try {
      await reopened.request(scope, "send", { id: branch.id, content: "Branch only" });
      await vi.waitFor(async () => expect((await reopened.request(scope, "read", { id: branch.id })).turns.at(-1)?.status).toBe("completed"));
      expect(options.run).toHaveBeenLastCalledWith(expect.objectContaining({ provider, resume: "native-branch", content: "Branch only" }), expect.any(Function), expect.any(AbortSignal));
      expect(await reopened.request(scope, "read", { id: source.id })).toEqual(before);
    } finally { await reopened.stop(); }
  });
  it("does not create a misleading copy when the native fork fails or returns the original identity", async () => {
    const { service, options } = await setup();
    const source = await service.request(scope, "create", { provider: "codex" });
    await expect(service.request(scope, "fork", { id: source.id })).rejects.toThrow("Send a message");
    await service.request(scope, "send", { id: source.id, content: "First" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: source.id })).turns[0]?.status).toBe("completed"));
    options.fork.mockRejectedValueOnce(new Error("Native transcript missing"));
    await expect(service.request(scope, "fork", { id: source.id })).rejects.toThrow("Native transcript missing");
    options.fork.mockResolvedValueOnce("native-thread");
    await expect(service.request(scope, "fork", { id: source.id })).rejects.toThrow("independent");
    expect(await service.request(scope, "list", {})).toHaveLength(1);
    await expect(service.request({ ...scope, workspaceId: "other" }, "fork", { id: source.id })).rejects.toThrow("not found");
  });
  it("freezes the source until native forking finishes and cancels publication on account change", async () => {
    const { service, options } = await setup();
    const source = await service.request(scope, "create", { provider: "claude" });
    await service.request(scope, "send", { id: source.id, content: "First" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: source.id })).turns[0]?.status).toBe("completed"));
    let release!: (id: string) => void;
    options.fork.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = service.request(scope, "fork", { id: source.id });
    const rejected = expect(pending).rejects.toThrow("no longer active");
    await vi.waitFor(() => expect(options.fork).toHaveBeenCalledOnce());
    await expect(service.request(scope, "send", { id: source.id, content: "Later" })).rejects.toThrow("finish forking");
    await expect(service.request(scope, "fork", { id: source.id })).rejects.toThrow("already being forked");
    const signal = options.fork.mock.calls[0]![1];
    service.setCurrentUser("other-user"); expect(signal.aborted).toBe(true); release("native-branch"); await rejected;
    service.setCurrentUser(scope.userId);
    expect(await service.request(scope, "list", {})).toHaveLength(1);
  });
  it.each([false, true])("cleans execution context after completion or failure (failed=%s), without persisting it", async (failed) => {
    const context = { systemPrompt: "private query instructions", env: { TEST_CREDENTIAL: "test-secret" }, dispose: vi.fn(async () => {}) };
    const prepare = vi.fn(async () => context);
    const { service, options } = await setup(async () => { if (failed) throw new Error("provider failed"); return { output: "Reply" }; }, prepare);
    const created = await service.request(scope, "create", { provider: "codex" });
    await service.request(scope, "send", { id: created.id, content: "Read a task" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: created.id })).turns[0]?.status).toBe(failed ? "failed" : "completed"));
    expect(prepare).toHaveBeenCalledWith(scope, expect.any(AbortSignal), { conversationId: created.id, references: [], timing: expect.objectContaining({ mark: expect.any(Function), measure: expect.any(Function) }), askUser: expect.any(Function), readAvatarFile: expect.any(Function) });
    expect(options.run).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining(context.systemPrompt), env: context.env, content: "Read a task" }), expect.any(Function), expect.any(AbortSignal));
    expect(context.dispose).toHaveBeenCalledOnce();
    await service.flush();
    const [folder] = await readdir(options.root);
    const persisted = await readFile(join(options.root, folder!, "conversations.json"), "utf8");
    expect(persisted).not.toContain(context.systemPrompt); expect(persisted).not.toContain("test-secret");
  });
  it("does not launch a provider when the account changes while query context is preparing", async () => {
    const context = { systemPrompt: "scoped query", env: {}, dispose: vi.fn(async () => {}) };
    let release!: (value: LocalExecutionContext) => void;
    const prepare = vi.fn(() => new Promise<LocalExecutionContext>((resolve) => { release = resolve; }));
    const { service, options } = await setup(undefined, prepare);
    const created = await service.request(scope, "create", { provider: "codex" });
    await service.request(scope, "send", { id: created.id, content: "Read a task" });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    service.setCurrentUser("other-user"); release(context); await service.stop();
    expect(options.run).not.toHaveBeenCalled(); expect(context.dispose).toHaveBeenCalledOnce();
  });
  it("restricts usage reads to the active account, workspace, and conversation's actual provider", async () => {
    const { service, options } = await setup();
    const entry = await service.request(scope, "create", { provider: "claude" });
    expect(await service.request(scope, "usage", { provider: "claude", id: entry.id, force: true })).toMatchObject({ context: { usedTokens: 120 } });
    expect(options.usage.read).toHaveBeenCalledWith("claude", expect.objectContaining({ id: entry.id }), true);
    await expect(service.request(scope, "usage", { provider: "codex", id: entry.id })).rejects.toThrow("does not match");
    await expect(service.request({ ...scope, workspaceId: "other" }, "usage", { provider: "claude", id: entry.id })).rejects.toThrow("not found");
    service.setCurrentUser("other-user");
    await expect(service.request(scope, "usage", { provider: "claude" })).rejects.toThrow("no longer active");
    expect(options.usage.read).toHaveBeenCalledOnce();
  });
  it("runs an ordinary provider locally, stores history, and resumes its native session after reopening", async () => {
    const { service, options } = await setup(async (_input, emit) => { emit({ type: "text", content: "Reply" }); return { output: "Reply", sessionId: "native-thread" }; });
    const created = await service.request(scope, "create", { provider: "codex" });
    await service.request(scope, "directory", { id: created.id });
    await service.request(scope, "send", { id: created.id, content: "First", model: "test-model" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: created.id })).turns[0]?.status).toBe("completed"));
    expect(options.run).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", model: "test-model", cwd: "/selected-directory", content: "First" }), expect.any(Function), expect.any(AbortSignal));
    // Reopening follows shutdown, which also waits for final image persistence.
    await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId);
    expect((await reopened.request(scope, "read", { id: created.id })).messages.map((message) => message.content)).toEqual(["First", "Reply"]);
    await reopened.request(scope, "send", { id: created.id, content: "Follow up" });
    await vi.waitFor(() => expect(options.run).toHaveBeenLastCalledWith(expect.objectContaining({ resume: "native-thread" }), expect.any(Function), expect.any(AbortSignal)));
    await expect(reopened.request(scope, "directory", { id: created.id })).rejects.toThrow("before sending");
    await reopened.stop();
  });
  it("cancels only the owned run and prevents concurrent submissions", async () => {
    const { service } = await setup((_input, _emit, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true })));
    const created = await service.request(scope, "create", { provider: "codex" });
    const sent = await service.request(scope, "send", { id: created.id, content: "Wait" });
    await expect(service.request(scope, "fork", { id: created.id })).rejects.toThrow("current execution");
    await expect(service.request(scope, "send", { id: created.id, content: "Duplicate" })).rejects.toThrow("current execution");
    await service.request(scope, "cancel", { id: created.id, turnId: sent.turnId });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: created.id })).turns[0]?.status).toBe("cancelled"));
  });
  it.each([
    ["codex", false], ["codex", true], ["claude", false], ["claude", true],
  ] as const)("continues the same %s conversation after stopping, with reopening=%s", async (provider, reopen) => {
    let calls = 0;
    const { service, options } = await setup(async (input, emit, signal) => {
      input.onSessionId?.("resumable-native-session");
      if (++calls === 2) {
        emit({ type: "text", content: "Partial reply before stopping" });
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }));
      }
      return { output: calls === 1 ? "Original context" : "Continued reply", sessionId: "resumable-native-session" };
    });
    const created = await service.request(scope, "create", { provider });
    await service.request(scope, "send", { id: created.id, content: "Keep this context" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: created.id })).turns[0]?.status).toBe("completed"));
    const interrupted = await service.request(scope, "send", { id: created.id, content: "Long-running request" });
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledTimes(2));
    await service.request(scope, "cancel", { id: created.id, turnId: interrupted.turnId });

    let current = service;
    if (reopen) {
      await service.stop();
      current = new LocalConversationService(options); current.setCurrentUser(scope.userId);
      cleanups.unshift(() => current.stop());
    }
    const stopped = await current.request(scope, "read", { id: created.id });
    expect(stopped.providerSessionId).toBe("resumable-native-session");
    expect(stopped.turns[1]).toMatchObject({ id: interrupted.turnId, status: "cancelled", events: [expect.objectContaining({ content: "Partial reply before stopping" })] });
    await current.request(scope, "send", { id: created.id, content: "Continue from the saved context" });
    await vi.waitFor(async () => expect((await current.request(scope, "read", { id: created.id })).turns[2]?.status).toBe("completed"));
    expect(options.run.mock.calls[2]?.[0]).toMatchObject({ provider, resume: "resumable-native-session", content: "Continue from the saved context", cwd: created.cwd });
    const continued = await current.request(scope, "read", { id: created.id });
    expect(continued.id).toBe(created.id);
    expect(continued.messages.map((message) => message.content)).toEqual(["Keep this context", "Original context", "Long-running request", "Continue from the saved context", "Continued reply"]);
    expect(options.run).toHaveBeenCalledTimes(3);
  });
  it("keeps account and workspace histories isolated and rejects local file traversal", async () => {
    const { service } = await setup();
    const created = await service.request(scope, "create", { provider: "codex" });
    const file = await service.request(scope, "fileStore", { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("private notes").toString("base64") });
    expect(await service.request(scope, "fileRead", file)).toMatchObject({ name: "notes.txt", data: Buffer.from("private notes").toString("base64") });
    await expect(service.request(scope, "fileRead", { id: "../../other-account" })).rejects.toThrow("identifier");
    await expect(service.request(scope, "fileInfo", { id: "../../other-account" })).rejects.toThrow("identifier");
    await expect(service.request({ ...scope, workspaceId: "other" }, "fileInfo", file)).rejects.toThrow("ENOENT");
    await expect(service.request({ ...scope, workspaceId: "other" }, "read", { id: created.id })).rejects.toThrow("not found");
    service.setCurrentUser("other-user");
    await expect(service.request(scope, "list", {})).rejects.toThrow("no longer active");
    expect(await service.request({ ...scope, userId: "other-user" }, "list", {})).toEqual([]);
  });
  it("keeps historical attachment paths readable and rejects unsafe persisted filenames", async () => {
    const { service } = await setup();
    const stored = await service.request(scope, "fileStore", { name: "legacy.png", mimeType: "image/png", data: Buffer.from("legacy pixels").toString("base64") });
    const info = await service.request(scope, "fileInfo", stored);
    const legacyPath = join(dirname(info.path), stored.id);
    await rename(info.path, legacyPath);
    const metadata = { name: info.name, mimeType: info.mimeType };
    await writeFile(`${legacyPath}.json`, JSON.stringify(metadata));
    expect(await service.request(scope, "fileInfo", stored)).toMatchObject({ path: legacyPath, size: 13 });
    expect(await service.request(scope, "fileRead", stored)).toMatchObject({ data: Buffer.from("legacy pixels").toString("base64") });
    await writeFile(`${legacyPath}.json`, JSON.stringify({ ...metadata, storageName: "../../outside.png" }));
    await expect(service.request(scope, "fileInfo", stored)).rejects.toThrow("Invalid stored file path");
  });
  it("stores JSON attachment bytes separately from their JSON metadata", async () => {
    const { service } = await setup();
    const content = '{"test":"user-owned content"}';
    const file = await service.request(scope, "fileStore", { name: "config.json", mimeType: "application/json", data: Buffer.from(content).toString("base64") });
    const loaded = await service.request(scope, "fileRead", file);
    expect(loaded.path.endsWith(".json")).toBe(true);
    expect(Buffer.from(loaded.data, "base64").toString("utf8")).toBe(content);
  });
  it("records independently named cloud executions without invoking a local provider", async () => {
    const { service, options } = await setup();
    const created = await service.request(scope, "create", { provider: "claude" });
    const sent = await service.request(scope, "remoteBegin", { id: created.id, content: "Review", agents: [{ id: "design", name: "Design reviewer" }, { id: "code", name: "Code reviewer" }] });
    await service.request(scope, "remoteUpdate", { id: created.id, turnId: sent.turns[1]!.id, sessionId: "cloud-code", taskId: "cloud-task", status: "completed", output: "Code result" });
    const current = await service.request(scope, "read", { id: created.id });
    expect(current.turns.map((turn) => turn.remote?.agentName)).toEqual(["Design reviewer", "Code reviewer"]);
    expect(current.turns.map((turn) => turn.status)).toEqual(["running", "completed"]);
    expect(current.messages.at(-1)?.content).toBe("Code result"); expect(options.run).not.toHaveBeenCalled();
  });
});
