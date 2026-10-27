import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalConversationService } from "../../../main/local-conversation-service";
import type { runLocalProvider } from "../../../main/local-provider-runner";
import { createLocalConversationParentService } from "./local-conversation-service";
import type { LocalConversationClient } from "@multica/tutti-agent-gui-host/local-protocol";
import { CREATE_TASK_MENTION_ID } from "@multica/tutti-agent-gui-host/local-protocol";

const mock = vi.hoisted(() => ({ api: {
  listAgents: vi.fn(), listMembers: vi.fn(), listRuntimes: vi.fn(), listChatSessions: vi.fn(), listPendingChatTasks: vi.fn(),
  createChatSession: vi.fn(), sendChatMessage: vi.fn(), listChatMessagesPage: vi.fn(), listTaskMessages: vi.fn(), listAgentTasksPage: vi.fn(),
  cancelTaskById: vi.fn(), getIssue: vi.fn(),
} }));
vi.mock("@multica/core/api", async (original) => ({ ...await original<typeof import("@multica/core/api")>(), api: mock.api }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
beforeEach(() => {
  vi.resetAllMocks();
  mock.api.listAgents.mockResolvedValue(["design", "code"].map((id) => ({ id, workspace_id: "ws", owner_id: "user", name: `${id} reviewer`, description: "Defined workspace agent", runtime_id: "cloud-runtime", runtime_bound: true, runtime_config: {}, visibility: "workspace", archived_at: null, permission_mode: "private", invocation_targets: [] })));
  mock.api.listMembers.mockResolvedValue([{ user_id: "user", role: "owner" }]);
  mock.api.listRuntimes.mockResolvedValue([{ id: "cloud-runtime", provider: "codex" }]);
  mock.api.listChatSessions.mockResolvedValue([{ id: "old-cloud-history", agent_id: "design", workspace_id: "ws" }]);
  mock.api.listPendingChatTasks.mockResolvedValue({ tasks: [] });
  mock.api.createChatSession.mockImplementation(async ({ agent_id }) => ({ id: `cloud-${agent_id}`, agent_id, workspace_id: "ws" }));
  mock.api.sendChatMessage.mockImplementation(async (id) => ({ task_id: `task-${id}`, message_id: `message-${id}`, created_at: "2026-01-01" }));
  mock.api.listChatMessagesPage.mockImplementation(async (id) => ({ messages: [{ id: `result-${id}`, role: "assistant", task_id: `task-${id}`, content: `RESULT_${id}`, created_at: "2026-01-01" }], has_more: false }));
  mock.api.listAgentTasksPage.mockImplementation(async (id) => ({ tasks: [{ id: `task-cloud-${id}`, chat_session_id: `cloud-${id}`, status: "completed" }], nextCursor: null }));
  mock.api.listTaskMessages.mockResolvedValue([]);
});
async function setup(getSelectionIntent?: () => string) {
  const root = await mkdtemp(join(tmpdir(), "multica-local-bridge-"));
  const listeners = new Set<Parameters<LocalConversationClient["subscribe"]>[0]>();
  const run = vi.fn<typeof runLocalProvider>(async () => ({ output: "LOCAL_RESULT", sessionId: "native-thread" }));
  const usage = { read: vi.fn(async () => ({ provider: "claude" as const, context: { usedTokens: 120, limitTokens: 1000, model: null, updatedAt: null }, account: { status: "unavailable" as const, plan: null, windows: [], updatedAt: null } })), reset: vi.fn() };
  const service = new LocalConversationService({ root, apiUrl: "https://example.test", run, usage, find: async () => "/test/fake", chooseDirectory: async () => null, notify: (scope, id) => listeners.forEach((listener) => listener(scope, id)) });
  service.setCurrentUser("user");
  const client: LocalConversationClient = { request: (scope, method, params) => service.request(scope, method, params), subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const values = new Map<string, string>();
  const onLocalSelect = vi.fn();
  const onOpenSide = vi.fn();
  const onOpenResource = vi.fn();
  const onShowMessage = vi.fn();
  const bridge = createLocalConversationParentService({ queryClient: qc, workspaceId: "ws", workspaceSlug: "workspace", userId: "user", isCurrent: () => true, resolveAvatar: (value) => value,
    onSelectSession: vi.fn(), onLocalSelect, onOpenSide, onOpenResource, getSelectionIntent, onOpenTask: vi.fn(), onShowMessage,
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } },
  }, client);
  cleanups.push(async () => { bridge.dispose(); qc.clear(); await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { bridge, run, service, usage, client, onLocalSelect, onOpenSide, onOpenResource, onShowMessage };
}
describe("local providers and official agent invocation routing", () => {
  it.each([
    ["large cases.pos", "application/octet-stream", 7_600_000],
    ["pasted screenshot.png", "image/png", 128],
  ])("returns a compact path reference for %s and reads bytes only on preview", async (name, mimeType, size) => {
    const { bridge, client } = await setup();
    const request = vi.spyOn(client, "request");
    const attachment = await bridge.request("attachment.upload", { file: new File([new Uint8Array(size).fill(65)], name, { type: mimeType }) });
    expect(attachment.url.startsWith("file://")).toBe(true);
    expect(JSON.stringify(attachment).length).toBeLessThan(2000);
    expect(request.mock.calls.some(([, method]) => method === "fileRead")).toBe(false);
    const session = await bridge.request("session.create", { agentId: "local:claude" });
    const content = `Read [@${name}](${attachment.markdown_url})`;
    const queued = await bridge.request("queue.enqueue", { sessionId: session.id, queued: true, paused: true, item: {
      requestId: "large-file", content, attachmentIds: [attachment.id],
      display: { id: "large-file", createdAtUnixMs: 1, content: [{ type: "text", text: content }] },
    } });
    expect(queued.items).toHaveLength(1);
    expect(JSON.stringify(queued).length).toBeLessThan(3000);
    const detail = await bridge.request("session.load", { sessionId: session.id });
    expect(detail.promptQueue?.items[0]?.attachmentIds).toEqual([attachment.id]);
    const preview = await bridge.request("attachment.read", { attachmentId: attachment.id });
    expect(preview).toMatchObject({ name, mimeType });
    expect(atob(preview.data)).toHaveLength(size);
  });
  it("hands queued work to Electron before tab disposal and reloads its live state", async () => {
    const { bridge, service, run } = await setup();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    run.mockImplementation(async () => { if (run.mock.calls.length === 1) await wait; return { output: "done", sessionId: "native-thread" }; });
    expect((await bridge.load()).queueOwner).toBe("desktop");
    const session = await bridge.request("session.create", { agentId: "local:codex" });
    const enqueue = (requestId: string) => bridge.request("queue.enqueue", { sessionId: session.id, queued: true, item: {
      requestId, content: requestId, display: { id: requestId, clientSubmitId: requestId, createdAtUnixMs: 1, content: [{ type: "text", text: requestId }] },
    } });
    await enqueue("first"); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await enqueue("second"); bridge.dispose(); finish();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    const restored = await service.request({ userId: "user", workspaceId: "ws" }, "read", { id: session.id });
    expect(restored.promptQueue?.paused).toBe(false);
    expect(restored.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["first", "second"]);
  });
  it("does not navigate back when an earlier GUI selection finishes after host navigation", async () => {
    let intent = "source";
    const { bridge, client, onLocalSelect } = await setup(() => intent);
    const session = await bridge.request("session.create", { agentId: "local:codex" });
    const read = client.request;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    client.request = (async (scope, method, params) => { if (method === "read") await gate; return read(scope, method, params); }) as typeof client.request;
    const pending = bridge.request("host.selectSession", { sessionId: session.id });
    intent = "newer-host-selection";
    resume(); await pending;
    expect(onLocalSelect).not.toHaveBeenCalled();
  });

  it("keeps the latest GUI selection when reads finish in reverse order", async () => {
    const { bridge, client, onLocalSelect } = await setup();
    const old = await bridge.request("session.create", { agentId: "local:codex" });
    const next = await bridge.request("session.create", { agentId: "local:claude" });
    const read = client.request;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    client.request = (async (scope, method, params) => { if (method === "read" && (params as { id: string }).id === old.id) await gate; return read(scope, method, params); }) as typeof client.request;
    const pending = bridge.request("host.selectSession", { sessionId: old.id });
    await bridge.request("host.selectSession", { sessionId: next.id });
    resume(); await pending;
    expect(onLocalSelect.mock.calls).toEqual([[next.id, "claude"]]);
  });
  it("passes Codex image paths through the desktop bridge and preserves queued attachments when moving to Side", async () => {
    const { bridge, service, run, client } = await setup();
    const scope = { userId: "user", workspaceId: "ws" };
    const source = await bridge.request("session.create", { agentId: "local:codex" });
    const data = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNQzjxBEmIY1TCqYfhqAAAciFQQmuMXLwAAAABJRU5ErkJggg==";
    const stored = await service.request(scope, "fileStore", { name: "screenshot.png", mimeType: "image/png", data });
    const image = await service.request(scope, "fileRead", stored);
    const requests = vi.spyOn(client, "request");
    await bridge.request("session.send", { sessionId: source.id, content: "Describe this image", attachmentIds: [stored.id] });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: source.id })).turns.at(-1)?.status).toBe("completed"));
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "codex", content: expect.stringContaining(image.path) }), expect.any(Function), expect.any(AbortSignal));

    const requestId = `side:${source.id}:queued-image`;
    const side = await bridge.request("host.openSide", { sessionId: source.id, requestId, pending: { requestId, content: "Queued image question", attachmentIds: [stored.id] } });
    await bridge.request("host.startSide", { sessionId: side.id });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: side.id })).turns.at(-1)?.status).toBe("completed"));
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "codex", resume: undefined,
      content: expect.stringContaining("Queued image question") }), expect.any(Function), expect.any(AbortSignal));
    expect(run.mock.calls.at(-1)?.[0].content).toContain(image.path);
    expect(run.mock.calls.at(-1)?.[0]).not.toHaveProperty("images");
    const saved = await service.request(scope, "read", { id: side.id });
    expect(saved.messages[0]?.attachmentIds).toEqual([stored.id]);
    expect(saved.side?.pending).toBeUndefined();
    expect((await service.request(scope, "read", { id: source.id })).messages).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(requests.mock.calls.some(([, method]) => method === "fileRead")).toBe(false);
  });
  it("leaves new conversations eligible for remembered defaults and retains inherited Side permissions", async () => {
    const { bridge, service, run } = await setup();
    const source = await bridge.request("session.create", { agentId: "local:codex" });
    expect((await bridge.request("session.load", { sessionId: source.id })).permissionMode).toBeUndefined();
    const side = await service.request({ userId: "user", workspaceId: "ws" }, "sideCreate", { id: source.id, requestId: "permission-inheritance" });
    expect((await bridge.request("session.load", { sessionId: side.id })).permissionMode).toBe("default");
    await bridge.request("session.send", { sessionId: source.id, content: "Saved permission", permissionMode: "auto" });
    await vi.waitFor(async () => expect((await bridge.request("session.load", { sessionId: source.id })).messages).toHaveLength(2));
    expect((await bridge.request("session.load", { sessionId: source.id })).permissionMode).toBe("auto");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "auto" }), expect.any(Function), expect.any(AbortSignal));
  });
  it.each(["codex", "claude"])("passes the New task mention to the local %s run without fetching a fake issue or creating on selection", async (provider) => {
    const { bridge, run } = await setup();
    const session = await bridge.request("session.create", { agentId: `local:${provider}` });
    await bridge.request("session.send", { sessionId: session.id, content: "Create the review task", references: [{ kind: "issue", id: CREATE_TASK_MENTION_ID }] });
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ content: "Create the review task" }), expect.any(Function), expect.any(AbortSignal));
    expect(mock.api.getIssue).not.toHaveBeenCalled();
    expect(mock.api.createChatSession).not.toHaveBeenCalled();
    expect(mock.api.sendChatMessage).not.toHaveBeenCalled();
  });
  it("reports that local task creation cannot be routed into an official agent invocation", async () => {
    const { bridge, run } = await setup();
    const session = await bridge.request("session.create", { agentId: "local:codex" });
    await expect(bridge.request("session.send", { sessionId: session.id, content: "Create task", references: [{ kind: "issue", id: CREATE_TASK_MENTION_ID }, { kind: "agent", id: "design" }] })).rejects.toThrow("local provider");
    expect(run).not.toHaveBeenCalled();
    expect(mock.api.createChatSession).not.toHaveBeenCalled();
  });
  it("identifies local conversation snapshots and provides their stable IDs for MCP lookup without changing authored history", async () => {
    const { bridge, run } = await setup();
    const source = await bridge.request("session.create", { agentId: "local:codex", title: "Source chat" });
    await bridge.request("session.send", { sessionId: source.id, content: "Original question " + "x".repeat(7000) });
    await vi.waitFor(async () => expect((await bridge.request("session.load", { sessionId: source.id })).messages).toHaveLength(2));
    run.mockClear();
    const target = await bridge.request("session.create", { agentId: "local:claude" });
    await bridge.request("session.send", { sessionId: target.id, content: "Read this conversation", references: [{ kind: "session", id: source.id }] });
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    for (const text of [`id: ${source.id}; workspace: ws`, "Earlier text omitted", "read_context"]) expect(run).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining(text) }), expect.any(Function), expect.any(AbortSignal));
    expect((await bridge.request("session.load", { sessionId: target.id })).messages[0]?.content).toBe("Read this conversation");
    expect(mock.api.sendChatMessage).not.toHaveBeenCalled();
  });
  it("identifies referenced tasks and explicitly marks incomplete snapshots without changing the authored message", async () => {
    const { bridge, run } = await setup();
    mock.api.getIssue.mockResolvedValue({ id: "issue-1", identifier: "TES-124", title: "Task", workspace_id: "ws", description: "x".repeat(7000) });
    const session = await bridge.request("session.create", { agentId: "local:codex" });
    await bridge.request("session.send", { sessionId: session.id, content: "Read this task", model: "selected-model", references: [{ kind: "issue", id: "issue-1" }] });
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("TES-124 (id: issue-1; workspace: ws)") }), expect.any(Function), expect.any(AbortSignal));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Description excerpt truncated") }), expect.any(Function), expect.any(AbortSignal));
    expect((await bridge.request("session.load", { sessionId: session.id })).messages[0]?.content).toBe("Read this task");
    expect((await bridge.request("session.load", { sessionId: session.id })).model).toBe("selected-model");
    expect(mock.api.sendChatMessage).not.toHaveBeenCalled();
  });
  it("reads local provider usage through IPC without invoking a model or creating an official chat", async () => {
    const { bridge, usage, run } = await setup();
    const session = await bridge.request("session.create", { agentId: "local:claude" });
    expect(await bridge.request("usage.read", { agentId: "local:claude", sessionId: session.id, force: true })).toMatchObject({ context: { usedTokens: 120 } });
    expect(usage.read).toHaveBeenCalledWith("claude", expect.objectContaining({ id: session.id }), true);
    expect(run).not.toHaveBeenCalled(); expect(mock.api.createChatSession).not.toHaveBeenCalled(); expect(mock.api.sendChatMessage).not.toHaveBeenCalled();
  });
  it("keeps ordinary provider sessions local and exposes cloud agents only as mention targets", async () => {
    const { bridge, run } = await setup();
    const state = await bridge.load();
    expect(state.executionTargets?.map((target) => target.name)).toEqual(["Codex", "Claude Code"]);
    expect(state.agents.map((target) => target.agent.name)).toEqual(["design reviewer", "code reviewer"]);
    expect(state.sessions).toEqual([]);
    const session = await bridge.request("session.create", { agentId: "local:codex" });
    const sent = await bridge.request("session.send", { sessionId: session.id, content: "Hello", model: "local-model" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", model: "local-model", content: "Hello" }), expect.any(Function), expect.any(AbortSignal));
    expect(mock.api.createChatSession).not.toHaveBeenCalled(); expect(mock.api.sendChatMessage).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect((await bridge.request("session.load", { sessionId: session.id })).messages).toContainEqual(expect.objectContaining({ content: "LOCAL_RESULT", task_id: sent.task_id })));
  });
  it("invokes two defined agents through existing official chat endpoints and returns both named runs locally", async () => {
    const { bridge, run } = await setup(); await bridge.load();
    const session = await bridge.request("session.create", { agentId: "local:codex" });
    await bridge.request("session.send", { sessionId: session.id, content: "Review", references: [{ kind: "agent", id: "design" }, { kind: "agent", id: "code" }] });
    await vi.waitFor(() => expect(mock.api.sendChatMessage).toHaveBeenCalledTimes(2));
    expect(mock.api.createChatSession.mock.calls.map(([request]) => request.agent_id).sort()).toEqual(["code", "design"]);
    for (const id of ["cloud-design", "cloud-code"]) {
      expect(mock.api.sendChatMessage).toHaveBeenCalledWith(id, expect.stringContaining("User request and referenced context:\n\nReview"), []);
    }
    for (const [, prompt] of mock.api.sendChatMessage.mock.calls) {
      expect(prompt).toContain("fenced code block with the language html");
      expect(prompt).toContain("fenced code block with the language svg");
      expect(prompt).toContain("Chart.js 4 (global Chart) and D3 7 (global d3)");
      expect(prompt).toContain("Return the markup itself in your assistant reply");
    }
    await vi.waitFor(async () => {
      const detail = await bridge.request("session.load", { sessionId: session.id });
      expect(detail.messages.filter((message) => message.role === "assistant").map((message) => message.content).sort()).toEqual(["RESULT_cloud-code", "RESULT_cloud-design"]);
      expect(detail.tasks?.map((task) => task.chat_invoked_agent_name).sort()).toEqual(["code reviewer", "design reviewer"]);
    }, { timeout: 5000 });
    expect(run).not.toHaveBeenCalled();
  });
  it("retains preview guidance on official agent follow-ups while keeping local user messages unchanged", async () => {
    const { bridge } = await setup(); await bridge.load();
    const session = await bridge.request("session.create", { agentId: "local:codex" });
    for (const [index, content] of ["Show an HTML chart", "Now show an SVG diagram"].entries()) {
      await bridge.request("session.send", { sessionId: session.id, content, references: [{ kind: "agent", id: "design" }] });
      await vi.waitFor(async () => expect((await bridge.request("session.load", { sessionId: session.id })).messages.filter((message) => message.role === "assistant")).toHaveLength(index + 1), { timeout: 4000 });
    }
    expect(mock.api.createChatSession).toHaveBeenCalledOnce();
    expect(mock.api.sendChatMessage).toHaveBeenCalledTimes(2);
    for (const [index, content] of ["Show an HTML chart", "Now show an SVG diagram"].entries()) {
      expect(mock.api.sendChatMessage.mock.calls[index]).toEqual(["cloud-design", expect.stringContaining(`User request and referenced context:\n\n${content}`), []]);
      expect(mock.api.sendChatMessage.mock.calls[index]![1]).toContain("fenced code block with the language html");
      expect(mock.api.sendChatMessage.mock.calls[index]![1]).toContain("fenced code block with the language svg");
    }
    expect((await bridge.request("session.load", { sessionId: session.id })).messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["Show an HTML chart", "Now show an SVG diagram"]);
  });
  it("waits for a durable reply when concurrent reads see task completion first", async () => {
    const { bridge } = await setup(); await bridge.load();
    mock.api.listChatMessagesPage.mockResolvedValueOnce({ messages: [], has_more: false });
    const session = await bridge.request("session.create", { agentId: "local:codex" });
    await bridge.request("session.send", { sessionId: session.id, content: "Review", references: [{ kind: "agent", id: "design" }] });
    await vi.waitFor(async () => expect((await bridge.request("session.load", { sessionId: session.id })).messages).toContainEqual(expect.objectContaining({ content: "RESULT_cloud-design" })), { timeout: 4000 });
    expect(mock.api.listChatMessagesPage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it("does not send to the cloud after cancellation while its session is being created", async () => {
    const { bridge, service } = await setup(); await bridge.load();
    let release!: (value: unknown) => void;
    mock.api.createChatSession.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const session = await bridge.request("session.create", { agentId: "local:codex" });
    const sent = await bridge.request("session.send", { sessionId: session.id, content: "Review", references: [{ kind: "agent", id: "design" }] });
    await vi.waitFor(() => expect(mock.api.createChatSession).toHaveBeenCalledOnce());
    await bridge.request("session.cancel", { sessionId: session.id, taskId: sent.task_id });
    release({ id: "cloud-design" });
    await vi.waitFor(async () => expect((await service.request({ userId: "user", workspaceId: "ws" }, "read", { id: session.id })).turns[0]?.remote?.sessionId).toBe("cloud-design"));
    expect(mock.api.sendChatMessage).not.toHaveBeenCalled();
  });
  it("cancels the real cloud task when cancellation crosses an accepted send", async () => {
    const { bridge, service } = await setup(); await bridge.load();
    let release!: (value: unknown) => void;
    mock.api.sendChatMessage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    mock.api.cancelTaskById.mockResolvedValue({ id: "crossed-task", status: "cancelled" });
    const session = await bridge.request("session.create", { agentId: "local:codex" });
    const sent = await bridge.request("session.send", { sessionId: session.id, content: "Review", references: [{ kind: "agent", id: "design" }] });
    await vi.waitFor(() => expect(mock.api.sendChatMessage).toHaveBeenCalledOnce());
    await bridge.request("session.cancel", { sessionId: session.id, taskId: sent.task_id });
    release({ task_id: "crossed-task" });
    await vi.waitFor(() => expect(mock.api.cancelTaskById).toHaveBeenCalledWith("crossed-task"));
    await vi.waitFor(async () => expect((await service.request({ userId: "user", workspaceId: "ws" }, "read", { id: session.id })).turns[0]).toMatchObject({ status: "cancelled", remote: { taskId: "crossed-task" } }));
  });
});


describe("recoverable local attachment hydration", () => {
  it.each(["missing", "old-runtime"])("preserves history and saved attachment references with a %s attachment reader", async (failure) => {
    const { bridge, service, client, onShowMessage } = await setup();
    const scope = { userId: "user", workspaceId: "ws" };
    const file = await service.request(scope, "fileStore", { name: "screen.png", mimeType: "image/png", data: Buffer.from("test-owned bytes").toString("base64") });
    const session = await service.request(scope, "create", { provider: "codex" });
    await service.request(scope, "send", { id: session.id, content: "Keep this text", attachmentIds: [file.id] });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: session.id })).turns[0]?.status).toBe("completed"));
    const original = client.request.bind(client);
    client.request = vi.fn(async (scope, method, params) => {
      if (failure === "old-runtime" && method === "capabilities") throw new Error("Unknown local conversation request");
      if (method === "fileInfo") throw new Error(failure === "old-runtime" ? "Unknown local conversation request" : "ENOENT: missing file");
      return original(scope, method, params);
    }) as typeof client.request;
    const detail = await bridge.request("session.load", { sessionId: session.id });
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0]?.content).toContain("Keep this text");
    expect(detail.messages[0]?.content).toContain("attachment(s) could not be loaded");
    expect(detail.messages[1]?.content).toBe("LOCAL_RESULT");
    expect(detail.messages[0]?.attachments).toBeUndefined();
    await bridge.request("session.load", { sessionId: session.id });
    expect(onShowMessage).toHaveBeenCalledTimes(1);
    const saved = await service.request(scope, "read", { id: session.id });
    expect(saved.messages[0]).toMatchObject({ content: "Keep this text", attachmentIds: [file.id] });
    expect(client.request).not.toHaveBeenCalledWith(scope, "fileRead", expect.anything());
    if (failure === "missing") {
      client.request = original;
      const recovered = await bridge.request("session.load", { sessionId: session.id });
      expect(recovered.messages[0]?.attachments).toHaveLength(1);
      expect(recovered.messages[0]?.content).toBe("Keep this text");
    }
  });
  it("keeps working attachments beside a failed one and does not hide session authorization failures", async () => {
    const { bridge, service, client } = await setup(); const scope = { userId: "user", workspaceId: "ws" };
    const files = await Promise.all(["first", "second"].map((name) => service.request(scope, "fileStore", { name: `${name}.png`, mimeType: "image/png", data: Buffer.from(name).toString("base64") })));
    const session = await service.request(scope, "create", { provider: "codex" });
    await service.request(scope, "send", { id: session.id, content: "Two pictures", attachmentIds: files.map((file) => file.id) });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: session.id })).turns[0]?.status).toBe("completed"));
    const original = client.request.bind(client);
    client.request = vi.fn(async (scope, method, params) => {
      if (method === "fileInfo" && (params as { id: string }).id === files[0]!.id) throw new Error("Unreadable attachment");
      return original(scope, method, params);
    }) as typeof client.request;
    const detail = await bridge.request("session.load", { sessionId: session.id });
    expect(detail.messages[0]?.attachments?.map((file) => file.id)).toEqual([files[1]!.id]);
    expect(detail.messages[0]?.content).toContain("1 attachment(s)");
    service.setCurrentUser("another-user");
    await expect(bridge.request("session.load", { sessionId: session.id })).rejects.toThrow();
  });
});

it("carries the originating conversation through a delayed transcript Side creation", async () => {
  let intent = "source";
  const { bridge, client, onOpenSide, onOpenResource } = await setup(() => intent);
  const source = await bridge.request("session.create", { agentId: "local:codex" });
  const raw = client.request;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  client.request = (async (scope, method, params) => { if (method === "sideCreate") await gate; return raw(scope, method, params); }) as typeof client.request;
  const pending = bridge.request("host.openSide", { sessionId: source.id, requestId: "late-side" });
  intent = "other-main";
  resume(); const side = await pending;
  expect(onOpenSide).toHaveBeenCalledWith(side.id, source.id);
  expect(onOpenSide).toHaveBeenCalledOnce();
  await bridge.request("host.openResource", { sessionId: source.id, url: "https://a.example/" });
  expect(onOpenResource).toHaveBeenCalledWith(source.id, "https://a.example/");
});
