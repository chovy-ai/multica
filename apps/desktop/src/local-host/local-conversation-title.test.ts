// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalTimingRecord } from "@multica/tutti-agent-gui-host/local-timing";
import type { LocalConversation } from "@multica/core/local-conversation/protocol";
import { CHAT_CONTEXT_SNAPSHOT_END, CHAT_CONTEXT_SNAPSHOT_START } from "@multica/core/chat/context-snapshot";
import { LocalConversationService } from "./local-conversation-service";
import { refreshGeneratedConversationTitle, summarizeLocalConversationTitle } from "./local-conversation-title";
import type { ConversationTitleGenerator } from "./local-conversation-title-generator";
import type { runLocalProvider } from "./local-provider-runner";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); });
const scope = { userId: "title-user", workspaceId: "title-workspace" };

async function modelTitleService(generateTitle: ConversationTitleGenerator) {
  const root = await mkdtemp(join(tmpdir(), "multica-model-title-test-"));
  const options = { timing: vi.fn<(record: LocalTimingRecord) => void>(), root, apiUrl: "https://title.example.test", generateTitle: vi.fn(generateTitle),
    run: vi.fn<typeof runLocalProvider>(async () => ({ output: "Assistant response", sessionId: "main-native-session" })),
    find: async () => "/test-owned/fake-provider", chooseDirectory: async () => null, notify: vi.fn() };
  const service = new LocalConversationService(options); service.setCurrentUser(scope.userId);
  cleanup.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { service, options };
}

describe("first-user-message conversation titles", () => {
  it("puts the actual request ahead of mention labels and excludes reference URLs", () => {
    const title = summarizeLocalConversationTitle("[@TES-131 review 另一个 pr](mention://workspace-issue/issue-131?workspaceId=workspace) 里面有什么内容，你是如何读取的");
    expect(title).toBe("里面有什么内容，你是如何读取的 · TES-131 review 另一个 pr");
    expect(title).not.toMatch(/mention:|workspaceId|\]\(/);
    const conversation = summarizeLocalConversationTitle("[@Reply with exactly LOCAL_CODEX_PROVIDER_CONNECTED. Do not call tools](mention://workspace-session/chat-1) 你能看到里面对话内容吗");
    expect(conversation.startsWith("你能看到里面对话内容吗 · ")).toBe(true);
  });

  it("summarizes Markdown as readable text and excludes host-supplied snapshots", () => {
    const content = "Please **Review** [the login flow](https://example.test/login).";
    expect(summarizeLocalConversationTitle(`${content}${CHAT_CONTEXT_SNAPSHOT_START}PRIVATE SNAPSHOT${CHAT_CONTEXT_SNAPSHOT_END}`)).toBe("Review the login flow.");
    expect(summarizeLocalConversationTitle("[@设计评审](mention://agent/reviewer)")).toBe("设计评审");
    expect(summarizeLocalConversationTitle("请帮我排查登录问题。还有另一件事需要讨论。\n\n不属于标题的细节")).toBe("排查登录问题。");
  });

  it("limits long titles without splitting composed emoji or exposing a URL", () => {
    const family = "👩‍👩‍👧‍👦";
    expect(summarizeLocalConversationTitle(family.repeat(60))).toBe(family.repeat(47) + "…");
    expect(summarizeLocalConversationTitle("![screenshot](data:image/png;base64,AAA)")).toBe("新会话");
  });

  it("refreshes old generated titles and preserves explicit names and fork lineage", () => {
    const content = "[@TES-131](mention://workspace-issue/issue) 查看任务详情";
    const entry = { title: content.slice(0, 60), messages: [{ role: "user", content }] } as LocalConversation;
    refreshGeneratedConversationTitle(entry);
    expect(entry.title).toBe("查看任务详情 · TES-131");
    const fork = { title: `${content.slice(0, 60)} · Fork`, forkedFrom: "source", messages: entry.messages } as LocalConversation;
    refreshGeneratedConversationTitle(fork);
    expect(fork.title).toBe("查看任务详情 · TES-131 · Fork");
    const named = { ...entry, title: "发布前检查", titleMode: "manual" as const };
    refreshGeneratedConversationTitle(named);
    expect(named.title).toBe("发布前检查");
  });

  it.each(["codex", "claude"] as const)("uses the first authored message for %s, persists it, and respects manual renames", async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "multica-title-test-"));
    const run = vi.fn(async () => ({ output: "Assistant result must not become the title", sessionId: "title-native-session" }));
    const options = { root, apiUrl: "https://title.example.test", run, find: async () => "/test-owned/fake-provider", chooseDirectory: async () => null, notify: vi.fn() };
    const service = new LocalConversationService(options);
    service.setCurrentUser(scope.userId);
    cleanup.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
    const entry = await service.request(scope, "create", { provider });
    await service.request(scope, "send", { id: entry.id, content: "[@TES-131](mention://workspace-issue/issue) 查看任务详情", prompt: "PRIVATE EXECUTION CONTEXT" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[0]?.status).toBe("completed"));
    expect((await service.request(scope, "list", {}))[0]?.title).toBe("查看任务详情 · TES-131");
    await service.request(scope, "send", { id: entry.id, content: "Second user message" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[1]?.status).toBe("completed"));
    expect((await service.request(scope, "read", { id: entry.id })).title).toBe("查看任务详情 · TES-131");
    expect(run).toHaveBeenCalledTimes(2);
    await service.request(scope, "update", { id: entry.id, title: "我的检查清单" });
    await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId);
    try { expect((await reopened.request(scope, "read", { id: entry.id })).title).toBe("我的检查清单"); }
    finally { await reopened.stop(); }
  });

  it("uses the same title logic when the first message invokes a defined agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "multica-title-remote-test-"));
    const service = new LocalConversationService({ root, apiUrl: "https://title.example.test", find: async () => "/test-owned/fake-provider", chooseDirectory: async () => null, notify: vi.fn() });
    service.setCurrentUser(scope.userId);
    cleanup.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
    const entry = await service.request(scope, "create", { provider: "codex" });
    await service.request(scope, "remoteBegin", { id: entry.id, content: "[@设计评审](mention://agent/reviewer) 请帮我评审登录界面", agents: [{ id: "reviewer", name: "设计评审" }] });
    expect((await service.request(scope, "read", { id: entry.id })).title).toBe("评审登录界面 · 设计评审");
  });
});

describe("background model title lifecycle", () => {
  it("does not compete with the foreground turn for a title inference", async () => {
    let reply!: () => void;
    const { service, options } = await modelTitleService(async () => "Background title");
    options.run.mockImplementationOnce(() => new Promise((resolve) => { reply = () => resolve({ output: "Done", sessionId: "main-native-session" }); }));
    const entry = await service.request(scope, "create", { provider: "codex" });
    try {
      await service.request(scope, "send", { id: entry.id, content: "PRIVATE_PROMPT" });
      await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
      expect(options.generateTitle).not.toHaveBeenCalled();
      reply();
      await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).title).toBe("Background title"));
      const records = options.timing.mock.calls.map(([record]) => record);
      const finished = records.findIndex((record) => record.stage === "turn.finished");
      expect(finished).toBeGreaterThan(-1);
      expect(records.findIndex((record) => record.stage === "title.generate")).toBeGreaterThan(finished);
      expect(records.filter((record) => record.stage.startsWith("title."))).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "title.generate", event: "end", background: true, outcome: "completed" }),
        expect.objectContaining({ stage: "title.persist", event: "end", background: true, outcome: "completed" }),
      ]));
      expect(records.filter((record) => record.stage === "turn.finished")).toHaveLength(1);
      expect(JSON.stringify(records)).not.toContain("PRIVATE_PROMPT");
    } finally { reply?.(); }
  });
  it.each(["codex", "claude"] as const)("lets the %s queue drain before generating a title", async (provider) => {
    let release!: () => void;
    const { service, options } = await modelTitleService(async () => "Queued title");
    options.run.mockResolvedValueOnce({ output: "First", sessionId: "main-native-session" });
    options.run.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ output: "Second", sessionId: "main-native-session" }); }));
    const entry = await service.request(scope, "create", { provider });
    try {
      for (const requestId of ["title-first", "title-second"]) await service.request(scope, "queueEnqueue", {
        id: entry.id, paused: true,
        item: { requestId, content: requestId, display: { id: requestId, clientSubmitId: requestId, content: [{ type: "text", text: requestId }], createdAtUnixMs: Date.now() } },
      });
      await service.request(scope, "queueUpdate", { id: entry.id, action: "resume" });
      await vi.waitFor(() => expect(options.run).toHaveBeenCalledTimes(2));
      expect(options.generateTitle).not.toHaveBeenCalled();
      release();
      await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).title).toBe("Queued title"));
      expect(options.generateTitle).toHaveBeenCalledOnce();
      expect(options.generateTitle.mock.calls[0]![0].content).toBe("title-first");
    } finally { release?.(); }
  });
  it.each(["codex", "claude"] as const)("keeps %s sends, replies, and follow-ups independent of pending title inference", async (provider) => {
    let finish!: (title: string) => void;
    const { service, options } = await modelTitleService(() => new Promise((resolve) => { finish = resolve; }));
    const entry = await service.request(scope, "create", { provider });
    await service.request(scope, "send", { id: entry.id, content: "[@TES-131](mention://workspace-issue/issue) 里面有什么内容，你是如何读取的", prompt: "PRIVATE EXECUTION CONTEXT", model: "selected-model" });
    await vi.waitFor(async () => {
      expect(options.generateTitle).toHaveBeenCalledOnce();
      expect((await service.request(scope, "read", { id: entry.id })).turns[0]?.status).toBe("completed");
    });
    expect((await service.request(scope, "read", { id: entry.id })).titleGeneration).toBe("pending");
    expect(options.generateTitle).toHaveBeenCalledWith(expect.objectContaining({ provider, model: "selected-model", content: "[@TES-131](mention://workspace-issue/issue) 里面有什么内容，你是如何读取的" }), expect.any(AbortSignal));
    await service.request(scope, "send", { id: entry.id, content: "Second request", model: "another-model" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[1]?.status).toBe("completed"));
    const before = await service.request(scope, "read", { id: entry.id });
    expect(before.titleGeneration).toBe("pending");
    expect(options.run).toHaveBeenCalledTimes(2);
    expect(options.run.mock.calls[1]?.[0]).toMatchObject({ resume: "main-native-session" });
    finish("查看 TES-131 任务与读取方式");
    await vi.waitFor(async () => expect((await service.request(scope, "list", {}))[0]?.title).toBe("查看 TES-131 任务与读取方式"));
    const titled = await service.request(scope, "read", { id: entry.id });
    expect(titled.titleGeneration).toBe("complete"); expect(titled.updatedAt).toBe(before.updatedAt);
    expect(titled.messages).toEqual(before.messages); expect(titled.turns).toEqual(before.turns);
    expect(options.generateTitle).toHaveBeenCalledOnce(); expect(options.run).toHaveBeenCalledTimes(2);
    await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId);
    try {
      expect((await reopened.request(scope, "read", { id: entry.id })).title).toBe("查看 TES-131 任务与读取方式");
      await reopened.request(scope, "list", {}); expect(options.generateTitle).toHaveBeenCalledOnce();
    } finally { await reopened.stop(); }
  });

  it("cancels title generation on manual rename and never applies a late result", async () => {
    let finish!: (title: string) => void;
    const { service, options } = await modelTitleService(() => new Promise((resolve) => { finish = resolve; }));
    const entry = await service.request(scope, "create", { provider: "codex" });
    await service.request(scope, "send", { id: entry.id, content: "帮我排查登录问题" });
    await vi.waitFor(() => expect(options.generateTitle).toHaveBeenCalledOnce());
    await service.request(scope, "update", { id: entry.id, title: "我的登录检查" });
    expect(options.generateTitle.mock.calls[0]![1].aborted).toBe(true);
    finish("模型的迟到标题"); await service.stop();
    expect((await service.request(scope, "read", { id: entry.id })).title).toBe("我的登录检查");
  });

  it("cancels account-scoped title jobs and ignores results returned after an account change", async () => {
    let finish!: (title: string) => void;
    const { service, options } = await modelTitleService(() => new Promise((resolve) => { finish = resolve; }));
    const entry = await service.request(scope, "create", { provider: "claude" });
    await service.request(scope, "send", { id: entry.id, content: "帮我排查登录问题" });
    await vi.waitFor(async () => { expect(options.generateTitle).toHaveBeenCalledOnce(); expect((await service.request(scope, "read", { id: entry.id })).turns[0]?.status).toBe("completed"); });
    service.setCurrentUser("another-account"); options.notify.mockClear();
    expect(options.generateTitle.mock.calls[0]![1].aborted).toBe(true);
    finish("另一账号不能收到的标题"); await service.stop();
    expect(options.notify).not.toHaveBeenCalled();
    service.setCurrentUser(scope.userId);
    expect((await service.request(scope, "read", { id: entry.id })).title).toBe("排查登录问题");
  });

  it("retains the readable fallback on failure without retrying on reads or subsequent messages", async () => {
    const { service, options } = await modelTitleService(async () => { throw new Error("Provider unavailable"); });
    const entry = await service.request(scope, "create", { provider: "codex" });
    await service.request(scope, "send", { id: entry.id, content: "帮我排查登录问题" });
    await vi.waitFor(async () => {
      const current = await service.request(scope, "read", { id: entry.id });
      expect(current.titleGeneration).toBe("failed"); expect(current.title).toBe("排查登录问题"); expect(current.turns[0]?.status).toBe("completed");
    });
    await service.request(scope, "list", {});
    await service.request(scope, "send", { id: entry.id, content: "Continue" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[1]?.status).toBe("completed"));
    expect(options.generateTitle).toHaveBeenCalledOnce();
  });

  it.each(["codex", "claude"] as const)("uses only the authored request when the %s title model returns control content", async (provider) => {
    const { service, options } = await modelTitleService(async () => "<reasoning_effort>10</reasoning_effort>");
    const entry = await service.request(scope, "create", { provider });
    const content = `请帮我设计 P2P 服务${CHAT_CONTEXT_SNAPSHOT_START}PRIVATE SNAPSHOT${CHAT_CONTEXT_SNAPSHOT_END}`;
    await service.request(scope, "send", { id: entry.id, content, prompt: "PRIVATE EXECUTION CONTEXT" });
    await vi.waitFor(async () => {
      const current = await service.request(scope, "read", { id: entry.id });
      expect(current.titleGeneration).toBe("failed");
      expect(current.title).toBe("设计 P2P 服务");
      expect(current.turns[0]?.status).toBe("completed");
    });
    await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId);
    try {
      expect((await reopened.request(scope, "read", { id: entry.id })).title).toBe("设计 P2P 服务");
    } finally { await reopened.stop(); }
    expect(options.generateTitle).toHaveBeenCalledOnce();
  });

  it("summarizes first-message agent mentions through the local provider without using the agent response", async () => {
    const { service, options } = await modelTitleService(async () => "登录界面设计评审");
    const entry = await service.request(scope, "create", { provider: "claude" });
    await service.request(scope, "remoteBegin", { id: entry.id, content: "[@设计评审](mention://agent/reviewer) 评审登录界面", agents: [{ id: "reviewer", name: "设计评审" }] });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).title).toBe("登录界面设计评审"));
    expect(options.generateTitle).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude", model: null, content: "[@设计评审](mention://agent/reviewer) 评审登录界面" }), expect.any(AbortSignal));
    expect(options.run).not.toHaveBeenCalled();
  });

  it("does not schedule inference for explicitly named conversations or read-only requests", async () => {
    const { service, options } = await modelTitleService(async () => "Must not be used");
    const entry = await service.request(scope, "create", { provider: "codex", title: "保留的会话名" });
    await service.request(scope, "send", { id: entry.id, content: "Review" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[0]?.status).toBe("completed"));
    await service.request(scope, "list", {});
    expect(options.generateTitle).not.toHaveBeenCalled();
  });

  it("aborts pending title inference and waits for its cleanup on service shutdown", async () => {
    const { service, options } = await modelTitleService((_input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    }));
    const entry = await service.request(scope, "create", { provider: "claude" });
    await service.request(scope, "send", { id: entry.id, content: "Review" });
    await vi.waitFor(() => expect(options.generateTitle).toHaveBeenCalledOnce());
    await service.stop(); expect(options.generateTitle.mock.calls[0]![1].aborted).toBe(true);
  });
});
