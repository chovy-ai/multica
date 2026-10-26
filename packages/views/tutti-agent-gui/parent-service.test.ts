import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { chatKeys } from "@multica/core/chat/queries";
import { ApiError } from "@multica/core/api";
import type { AgentGuiHostEvent } from "@multica/tutti-agent-gui-host/protocol";
import type { Agent, ChatSession, StorageAdapter } from "@multica/core/types";
import { createAgentGuiParentService } from "./parent-service";
import { CREATE_TASK_MENTION_ID } from "@multica/tutti-agent-gui-host/local-protocol";

const mocked = vi.hoisted(() => ({ enqueueRestore: vi.fn(), api: {
  listAgents: vi.fn(), listMembers: vi.fn(), listRuntimes: vi.fn(),
  listChatSessions: vi.fn(), getChatSession: vi.fn(), listChatMessagesPage: vi.fn(),
  getPendingChatTask: vi.fn(), listPendingChatTasks: vi.fn(), listAgentTasksPage: vi.fn(), listChatSessionTasksPage: vi.fn(), sendChatAgentMessage: vi.fn(), listTaskMessages: vi.fn(),
  createChatSession: vi.fn(), sendChatMessage: vi.fn(), updateChatSession: vi.fn(),
  setChatSessionPinned: vi.fn(), markChatSessionRead: vi.fn(), cancelTaskById: vi.fn(),
  initiateListModels: vi.fn(), getListModelsResult: vi.fn(),
  uploadFile: vi.fn(), getAttachmentBlob: vi.fn(), listIssues: vi.fn(), getIssue: vi.fn(), listIssueStatuses: vi.fn(),
} }));
vi.mock("@multica/core/api", async (importOriginal) => ({ ...await importOriginal<typeof import("@multica/core/api")>(), api: mocked.api }));
vi.mock("@multica/core/chat", () => ({ useChatStore: { getState: () => ({ enqueuePendingSendRestore: mocked.enqueueRestore }) } }));

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const taskId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const agent = { id: "agent", workspace_id: "ws", runtime_id: "runtime", runtime_bound: true,
  runtime_config: {}, runtime_availability: "online", visibility: "workspace", archived_at: null,
  name: "Code agent", owner_id: "user", permission_mode: "private", invocation_targets: [] } as unknown as Agent;
const chat = { id: sessionId, workspace_id: "ws", agent_id: "agent", status: "active", title: "Real session" } as ChatSession;
const cleanups: Array<() => void> = [];

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let active = true;
  const values = new Map<string, string>();
  const storage: StorageAdapter = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
  const onSelectSession = vi.fn();
  const onOpenInternalResource = vi.fn();
  const service = createAgentGuiParentService({ queryClient: qc, workspaceId: "ws", workspaceSlug: "acme", userId: "user",
    storage, isCurrent: () => active, resolveAvatar: (url) => url, onSelectSession,
    onOpenTask: vi.fn(), onOpenInternalResource, getAppOrigin: () => "https://app.example.test", onShowMessage: vi.fn() });
  cleanups.push(() => { service.dispose(); qc.clear(); });
  return { service, qc, values, onSelectSession, onOpenInternalResource, leave: () => { active = false; } };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.api.listAgents.mockResolvedValue([agent]);
  mocked.api.listMembers.mockResolvedValue([{ user_id: "user", role: "owner" }]);
  mocked.api.listChatSessions.mockResolvedValue([chat]);
  mocked.api.listRuntimes.mockResolvedValue([{ id: "runtime", provider: "codex" }]);
  mocked.api.getChatSession.mockResolvedValue(chat);
  mocked.api.listChatMessagesPage.mockResolvedValue({ messages: [], has_more: false });
  mocked.api.getPendingChatTask.mockResolvedValue({});
  mocked.api.listPendingChatTasks.mockResolvedValue({ tasks: [] });
  mocked.api.listChatSessionTasksPage.mockResolvedValue({ tasks: [], nextCursor: null });
  mocked.api.listAgentTasksPage.mockResolvedValue({ tasks: [], nextCursor: null });
  mocked.api.listTaskMessages.mockResolvedValue([]);
  mocked.api.listIssueStatuses.mockResolvedValue({ statuses: [] });
});
afterEach(() => { cleanups.splice(0).forEach((fn) => fn()); });

describe("Tutti GUI parent integration", () => {
  it("opens validated internal resources without creating a conversation or calling a model", async () => {
    const { service, onOpenInternalResource } = setup();
    await service.request("host.openInternalResource", { href: `https://app.example.test/acme/agents/${sessionId}?view=general#avatar` });
    expect(onOpenInternalResource).toHaveBeenLastCalledWith(`/acme/agents/${sessionId}?view=general#avatar`, false);
    await service.request("host.openInternalResource", { href: "mention://issue/TES-124?workspaceId=ws", background: true });
    expect(onOpenInternalResource).toHaveBeenLastCalledWith("/acme/issues/TES-124", true);
    expect(mocked.api.createChatSession).not.toHaveBeenCalled(); expect(mocked.api.sendChatMessage).not.toHaveBeenCalled();
  });
  it("rejects foreign or malformed internal navigation before opening anything", async () => {
    const { service, onOpenInternalResource, leave } = setup();
    for (const href of [`https://other.example/acme/agents/${sessionId}`, `https://app.example.test/other/agents/${sessionId}`, `mention://agent/${sessionId}?workspaceId=other`, "/acme/agents/new"]) {
      await expect(service.request("host.openInternalResource", { href })).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(service.request("host.openInternalResource", { href: `/acme/agents/${sessionId}`, background: "true" } as never)).rejects.toMatchObject({ code: "invalid_request" });
    leave();
    await expect(service.request("host.openInternalResource", { href: `/acme/agents/${sessionId}` })).rejects.toBeInstanceOf(Error);
    expect(onOpenInternalResource).not.toHaveBeenCalled();
  });
  it("keeps the New task action on the local provider route instead of treating it as an existing cloud task", async () => {
    const { service } = setup();
    await expect(service.request("session.send", { sessionId, content: "Create a task", references: [{ kind: "issue", id: CREATE_TASK_MENTION_ID }] })).rejects.toMatchObject({ code: "local_provider_required" });
    expect(mocked.api.getIssue).not.toHaveBeenCalled();
    expect(mocked.api.sendChatMessage).not.toHaveBeenCalled();
  });
  it("resolves custom task status names from the workspace catalog, including archived definitions", async () => {
    const { service } = setup();
    mocked.api.listIssues.mockResolvedValue({ issues: [{ id: "qa-task", workspace_id: "ws", identifier: "TES-1", title: "Review", status: "qa" }] });
    mocked.api.listIssueStatuses.mockResolvedValue({ statuses: [{ key: "qa", name: "等待验收", category: "started", is_system: false, archived_at: "2026-01-01" }] });
    expect(await service.request("context.tasks", { query: "", limit: 10 })).toEqual([expect.objectContaining({ status: "qa", statusLabel: "等待验收", statusCategory: "started" })]);
    expect(mocked.api.listIssueStatuses).toHaveBeenCalledWith(true);
  });
  it("keeps task references usable when an older server cannot provide its status catalog", async () => {
    const { service } = setup();
    mocked.api.listIssues.mockResolvedValue({ issues: [{ id: "task", workspace_id: "ws", identifier: "TES-1", title: "Review", status: "done" }] });
    mocked.api.listIssueStatuses.mockRejectedValue(new ApiError("not found", 404, "Not Found"));
    expect(await service.request("context.tasks", { query: "", limit: 10 })).toEqual([expect.objectContaining({ id: "task", status: "done" })]);
  });
  it("loads official server history through agent task pages when the session projection is unavailable", async () => {
    const own = { id: taskId, chat_session_id: sessionId };
    mocked.api.listChatMessagesPage.mockResolvedValue({ messages: [{ id: "message", task_id: taskId, content: "hello", created_at: "2026-01-01" }], has_more: false });
    mocked.api.listChatSessionTasksPage.mockRejectedValue(new ApiError("not found", 404, "Not Found"));
    mocked.api.listAgentTasksPage.mockResolvedValueOnce({ tasks: [{ id: "foreign", chat_session_id: "other" }], nextCursor: "older" })
      .mockResolvedValueOnce({ tasks: [own], nextCursor: null });
    const { service } = setup();
    expect(await service.request("session.load", { sessionId })).toMatchObject({ tasks: [own] });
    expect(mocked.api.listAgentTasksPage).toHaveBeenNthCalledWith(2, agent.id, { limit: 200, before: "older" });
    await service.request("session.load", { sessionId });
    expect(mocked.api.listChatSessionTasksPage).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 500])("does not hide server task failures (%s) behind compatibility reads", async (status) => {
    mocked.api.listChatSessionTasksPage.mockRejectedValue(new ApiError("failure", status, "Failure"));
    const { service } = setup();
    await expect(service.request("session.load", { sessionId })).rejects.toMatchObject({ status });
    expect(mocked.api.listAgentTasksPage).not.toHaveBeenCalled();
  });

  it("explains unsupported multi-agent execution without sending through a different agent", async () => {
    mocked.api.sendChatAgentMessage.mockRejectedValue(new ApiError("not found", 404, "Not Found"));
    const { service } = setup();
    await expect(service.request("session.send", { sessionId, content: "Review", references: [{ kind: "agent", id: agent.id }] })).rejects.toMatchObject({ code: "unsupported_agent_invocation", status: 404 });
    expect(mocked.api.sendChatMessage).not.toHaveBeenCalled();
  });

  it("preserves distinct Multica emoji and uploaded avatars through the GUI image-only port", async () => {
    mocked.api.listAgents.mockResolvedValue([
      { ...agent, id: "design", avatar_url: "emoji:🦉" },
      { ...agent, id: "code", avatar_url: "emoji:🐙" },
      { ...agent, id: "photo", avatar_url: "https://example.test/agent.png" },
      { ...agent, id: "default", avatar_url: null },
    ]);
    const { service } = setup();
    const { agents } = await service.load();
    expect(decodeURIComponent(agents[0]!.iconUrl)).toContain("🦉");
    expect(decodeURIComponent(agents[1]!.iconUrl)).toContain("🐙");
    expect(agents[0]!.iconUrl).not.toBe(agents[1]!.iconUrl);
    expect(agents[0]!.iconUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(agents[2]!.iconUrl).toBe("https://example.test/agent.png");
    expect(decodeURIComponent(agents[3]!.iconUrl)).toContain("🤖");
  });

  it("uses runtime liveness when the agent availability summary is absent or stale", async () => {
    mocked.api.listAgents.mockResolvedValue([{ ...agent, runtime_availability: undefined }]);
    mocked.api.listRuntimes.mockResolvedValue([{ id: "runtime", provider: "codex", status: "online", last_seen_at: new Date().toISOString() }]);
    const { service } = setup();
    expect((await service.load()).agents[0]).toMatchObject({ runtimeOnline: true });
    mocked.api.listAgents.mockResolvedValue([agent]);
    mocked.api.listRuntimes.mockResolvedValue([{ id: "runtime", provider: "codex", status: "offline", last_seen_at: "2020-01-01T00:00:00Z" }]);
    expect((await service.load()).agents[0]).toMatchObject({ runtimeOnline: false });
  });

  it("loads and refreshes the selected agent's real runtime model catalog with current permission checks", async () => {
    mocked.api.initiateListModels.mockResolvedValue({ id: "catalog-request", runtime_id: "runtime", status: "completed", models: [{ id: "runtime-model", label: "Runtime model" }], supported: true });
    const { service } = setup();
    expect(await service.request("models.list", { agentId: agent.id })).toMatchObject({ supported: true, models: [{ id: "runtime-model" }] });
    expect(mocked.api.initiateListModels).toHaveBeenCalledWith("runtime");
    await service.request("models.list", { agentId: agent.id, force: true });
    expect(mocked.api.initiateListModels).toHaveBeenLastCalledWith("runtime", { force: true });
    const calls = mocked.api.initiateListModels.mock.calls.length;
    await expect(service.request("models.list", { agentId: "other-workspace-agent" })).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(mocked.api.initiateListModels).toHaveBeenCalledTimes(calls);
    await expect(service.request("models.list", { agentId: agent.id, force: "yes" } as never)).rejects.toMatchObject({ status: 400 });
  });

  it("forwards only an explicit valid per-turn model and preserves the legacy default send shape", async () => {
    const { service } = setup();
    await service.request("session.send", { sessionId, content: "One turn", model: "runtime-model" });
    expect(mocked.api.sendChatMessage).toHaveBeenLastCalledWith(sessionId, "One turn", undefined, { model: "runtime-model" });
    await service.request("session.send", { sessionId, content: "Inherited" });
    expect(mocked.api.sendChatMessage).toHaveBeenLastCalledWith(sessionId, "Inherited", undefined);
    await expect(service.request("session.send", { sessionId, content: "Invalid", model: " " })).rejects.toMatchObject({ status: 400 });
  });

  it("queries tasks in the current workspace and includes only selected, authorized reference context", async () => {
    const { service } = setup();
    const issue = { id: "issue-1", workspace_id: "ws", identifier: "DEV-1", title: "Review", description: "Acceptance criteria", status: "todo" };
    mocked.api.listIssues.mockResolvedValue({ issues: [issue, { ...issue, id: "foreign", workspace_id: "other" }] });
    mocked.api.getIssue.mockResolvedValue(issue);
    mocked.api.listChatMessagesPage.mockResolvedValue({ messages: [{ role: "assistant", content: `Saved result sk-${"A".repeat(30)}\n\n<!-- multica-context-snapshot:start -->\nPrior context\n<!-- multica-context-snapshot:end -->` }], has_more: true });
    expect(await service.request("context.tasks", { query: "Review", limit: 10 })).toEqual([expect.objectContaining({ id: "issue-1", label: "DEV-1 Review" })]);
    expect(mocked.api.listIssues).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: "ws", q: "Review", limit: 10 }));
    await service.request("session.send", { sessionId, content: "Use the references", references: [
      { kind: "issue", id: "issue-1" }, { kind: "session", id: sessionId },
    ] });
    const sent = mocked.api.sendChatMessage.mock.calls[0]![1];
    expect(sent).toContain("Use the references");
    expect(sent).toContain("[DEV-1](mention://issue/issue-1)");
    expect(sent).toContain("Acceptance criteria");
    expect(sent).toContain("assistant: Saved result");
    expect(sent).not.toContain(`sk-${"A".repeat(30)}`);
    expect(sent).toContain("[Earlier messages omitted]");
    expect(mocked.api.listChatMessagesPage).toHaveBeenCalledWith(sessionId, { limit: 12 });
    expect(sent.match(/multica-context-snapshot:start/g)).toHaveLength(1);
    expect(sent).not.toContain("Agent: Code agent");
    expect(mocked.api.sendChatMessage.mock.calls[0]).toHaveLength(3);
    await service.request("session.send", { sessionId, content: sent, references: [{ kind: "issue", id: "issue-1" }] });
    const resent = mocked.api.sendChatMessage.mock.calls[1]![1];
    expect(resent.match(/Referenced context \(snapshot\)/g)).toHaveLength(1);
    expect(resent).not.toContain("Saved result");
  });

  it("dispatches all mentioned workspace agents through the invocation endpoint and uses their configured models", async () => {
    const reviewer = { ...agent, id: "reviewer", name: "设计评审师", description: "Review design", model: "reviewer-model" };
    mocked.api.listAgents.mockResolvedValue([agent, reviewer]);
    mocked.api.sendChatAgentMessage.mockResolvedValue({message_id: "m",task_id:"t",created_at:"now",agent_runs:[{agent_id:reviewer.id,agent_name:reviewer.name,task_id:"t",message_id:"m"}]});
    const { service } = setup();
    await service.request("session.send", { sessionId, content: "Review", model: "default-agent-model", references: [{kind:"agent",id:reviewer.id},{kind:"agent",id:agent.id},{kind:"agent",id:reviewer.id}] });
    expect(mocked.api.sendChatAgentMessage).toHaveBeenCalledWith(sessionId,"Review",[reviewer.id,agent.id],undefined);
    expect(mocked.api.sendChatMessage).not.toHaveBeenCalled();
  });

  it("rejects an unavailable mention before dispatching any recipient", async () => {
    mocked.api.listAgents.mockResolvedValue([agent,{...agent,id:"unbound",runtime_id:"",runtime_bound:false}]);
    const {service}=setup();
    await expect(service.request("session.send",{sessionId,content:"Review",references:[{kind:"agent",id:agent.id},{kind:"agent",id:"unbound"}]})).rejects.toMatchObject({code:"agent_unavailable"});
    expect(mocked.api.sendChatAgentMessage).not.toHaveBeenCalled();
    expect(mocked.api.sendChatMessage).not.toHaveBeenCalled();
  });

  it("rejects invalid, oversized, foreign and stale references before sending to an agent", async () => {
    const { service, leave } = setup();
    await expect(service.request("context.tasks", { query: "", limit: 0 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.request("session.send", { sessionId, content: "Review", references: Array(6).fill({ kind: "issue", id: "issue-1" }) })).rejects.toMatchObject({ code: "invalid_reference" });
    mocked.api.getIssue.mockResolvedValue({ id: "issue-1", workspace_id: "other" });
    await expect(service.request("session.send", { sessionId, content: "Review", references: [{ kind: "issue", id: "issue-1" }] })).rejects.toMatchObject({ code: "invalid_reference", status: 403 });
    let resolve!: (value: unknown) => void;
    mocked.api.getIssue.mockReturnValue(new Promise((done) => { resolve = done; }));
    const sending = service.request("session.send", { sessionId, content: "Review", references: [{ kind: "issue", id: "issue-1" }] });
    await vi.waitFor(() => expect(mocked.api.getIssue).toHaveBeenCalledTimes(2));
    leave(); resolve({ id: "issue-1", workspace_id: "ws", title: "Review" });
    await expect(sending).rejects.toMatchObject({ code: "stale_workspace" });
    expect(mocked.api.sendChatMessage).not.toHaveBeenCalled();
  });
  it("uses real agent identities and scopes GUI persistence to the account and workspace", async () => {
    const pending = { task_id: taskId, status: "running", chat_session_id: sessionId };
    mocked.api.listPendingChatTasks.mockResolvedValue({ tasks: [pending, { ...pending, chat_session_id: "another-workspace-session" }] });
    const { service, values } = setup();
    const state = await service.load();
    expect(state.agents[0]).toMatchObject({ agent, provider: "codex", canInvoke: true, runtimeBound: true });
    expect(state.pendingTasks).toEqual([pending]);
    await service.request("storage.write", { key: "../../token", value: "session-aliases" });
    expect([...values.keys()]).toEqual(["multica:tutti-gui:user:ws:..%2F..%2Ftoken"]);
    expect(await service.request("storage.read", { key: "../../token" })).toBe("session-aliases");
  });

  it("rejects cross-workspace sessions before reading messages or mutating them", async () => {
    const { service } = setup();
    mocked.api.getChatSession.mockResolvedValue({ ...chat, workspace_id: "other" });
    await expect(service.request("session.load", { sessionId })).rejects.toMatchObject({ code: "invalid_session" });
    await expect(service.request("session.send", { sessionId, content: "hello" })).rejects.toMatchObject({ code: "invalid_session" });
    expect(mocked.api.listChatMessagesPage).not.toHaveBeenCalled();
    expect(mocked.api.sendChatMessage).not.toHaveBeenCalled();
  });

  it("rejects stale asynchronous completions before changing host selection", async () => {
    const { service, leave, onSelectSession } = setup();
    let resolve!: (value: ChatSession) => void;
    mocked.api.getChatSession.mockReturnValue(new Promise<ChatSession>((done) => { resolve = done; }));
    const request = service.request("host.selectSession", { sessionId });
    leave(); resolve(chat);
    await expect(request).rejects.toMatchObject({ code: "stale_workspace" });
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("hydrates every message page and refuses a nonadvancing server cursor", async () => {
    const { service } = setup();
    const cursor = { created_at: "2026-01-01", id: "older" };
    mocked.api.listChatMessagesPage.mockResolvedValue({ messages: [], has_more: true, next_cursor: cursor });
    await expect(service.request("session.load", { sessionId })).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(mocked.api.listChatMessagesPage).toHaveBeenCalledTimes(2);
  });

  it("holds the active task query so Multica realtime streaming is not dropped, and releases it on unwatch", async () => {
    const { service, qc } = setup();
    mocked.api.getPendingChatTask.mockResolvedValue({ task_id: taskId, status: "running" });
    await service.request("session.watch", { sessionIds: [sessionId] });
    await vi.waitFor(() => expect(qc.getQueryCache().find({ queryKey: chatKeys.taskMessages(taskId) })?.getObserversCount()).toBe(1));
    const events: AgentGuiHostEvent[] = [];
    service.subscribe((event) => events.push(event));
    qc.setQueryData(chatKeys.taskMessages(taskId), [{ seq: 1, type: "text", content: "partial" }]);
    await vi.waitFor(() => expect(events).toContainEqual({ type: "invalidate", scope: "task", sessionId, taskId }));
    expect(events).not.toContainEqual({ type: "invalidate", scope: "session", sessionId });
    expect(mocked.api.listChatMessagesPage).not.toHaveBeenCalled();
    await service.request("session.watch", { sessionIds: [] });
    expect(qc.getQueryCache().find({ queryKey: chatKeys.taskMessages(taskId) })?.getObserversCount()).toBe(0);
  });

  it("authorizes output from loaded runs and preserves the existing secret redaction", async () => {
    const { service } = setup();
    await expect(service.request("task.messages", { taskId })).rejects.toMatchObject({ code: "invalid_task" });
    mocked.api.listChatMessagesPage.mockResolvedValue({ messages: [{ id: "message", task_id: taskId, content: "hi", created_at: "2026-01-01" }], has_more: false });
    await service.request("session.load", { sessionId });
    mocked.api.listTaskMessages.mockResolvedValue([{ seq: 1, content: `sk-${"A".repeat(30)}`, output: `ghp_${"b".repeat(36)}` }]);
    const output = await service.request("task.messages", { taskId });
    expect(output[0]).toMatchObject({ content: "[REDACTED API KEY]", output: "[REDACTED GITHUB TOKEN]" });
  });

  it("publishes a reopened live task's HTTP backfill even when its cache already held partial output", async () => {
    const { service, qc } = setup();
    mocked.api.getPendingChatTask.mockResolvedValue({ task_id: taskId, status: "running" });
    qc.setQueryData(chatKeys.taskMessages(taskId), [{ seq: 1, type: "text", content: "early" }]);
    mocked.api.listTaskMessages.mockResolvedValue([{ seq: 2, type: "text", content: "backfilled" }]);
    const events: AgentGuiHostEvent[] = [];
    service.subscribe((event) => events.push(event));
    await service.request("session.watch", { sessionIds: [sessionId] });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "invalidate", scope: "task", sessionId, taskId }));
    const messages = await service.request("task.messages", { taskId });
    expect(messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(mocked.api.listTaskMessages).toHaveBeenCalledTimes(1);
    expect(mocked.api.listChatMessagesPage).not.toHaveBeenCalled();
  });

  it("cancels only a real pending task of this session and never substitutes hard deletion", async () => {
    const { service } = setup();
    await expect(service.request("session.cancel", { sessionId, taskId })).rejects.toMatchObject({ code: "invalid_task" });
    expect(mocked.api.cancelTaskById).not.toHaveBeenCalled();
    await expect(service.request("session.delete", { sessionId })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("persists a synchronous cancellation restore until the source composer acknowledges it", async () => {
    const { service } = setup();
    mocked.api.getPendingChatTask.mockResolvedValue({ task_id: taskId, status: "queued" });
    const attachments = [{ id: "attachment", filename: "notes.txt" }];
    mocked.api.cancelTaskById.mockResolvedValue({ id: taskId, cancelled_chat_message: {
      restore_to_input: true, message_id: "message", chat_session_id: sessionId, content: "recover my prompt", attachments,
    } });
    await service.request("session.cancel", { sessionId, taskId });
    expect(mocked.enqueueRestore).toHaveBeenCalledWith({ id: "message", sessionId, content: "recover my prompt", attachments });
  });

  it("does not cancel after the workspace changes while checking the pending run", async () => {
    const { service, leave } = setup();
    let resolve!: (value: { task_id: string }) => void;
    mocked.api.getPendingChatTask.mockReturnValue(new Promise<{ task_id: string }>((done) => { resolve = done; }));
    const operation = service.request("session.cancel", { sessionId, taskId });
    await vi.waitFor(() => expect(mocked.api.getPendingChatTask).toHaveBeenCalled());
    leave(); resolve({ task_id: taskId });
    await expect(operation).rejects.toMatchObject({ code: "stale_workspace" });
    expect(mocked.api.cancelTaskById).not.toHaveBeenCalled();
  });

  it("does not rebroadcast already read sessions while source attention state is reconciled", async () => {
    const { service, qc } = setup();
    qc.setQueryData(chatKeys.sessions("ws"), [{ ...chat, has_unread: true, unread_count: 1 }]);
    const events: AgentGuiHostEvent[] = [];
    service.subscribe((event) => events.push(event));
    await service.request("session.markRead", { sessionId });
    await Promise.resolve();
    const count = events.length;
    await service.request("session.markRead", { sessionId });
    await Promise.resolve();
    expect(mocked.api.markChatSessionRead).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(count);
  });
});
