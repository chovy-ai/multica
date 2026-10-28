import { createLocalTiming } from "@multica/tutti-agent-gui-host/local-timing";
import { getLocalConversationClient } from "./local-conversation-client";
import { api } from "@multica/core/api";
import { chatKeys } from "@multica/core/chat/queries";
import type { AgentTask, Attachment } from "@multica/core/types";
import { createAgentGuiParentService, type ParentServiceOptions } from "@multica/views/conversation-flow/service";
import type { AgentGuiHostEvent, AgentGuiRpcMethod, AgentGuiRpcMethods, AgentGuiSessionDetail, AgentGuiWorkspaceState } from "@multica/tutti-agent-gui-host/protocol";
import type { LocalConversation, LocalConversationClient, LocalConversationEvent, LocalConversationScope, LocalConversationTurn, LocalProviderId } from "@multica/tutti-agent-gui-host/local-protocol";
import { HTML_PREVIEW_INSTRUCTIONS } from "@multica/tutti-agent-gui-host/html-preview";
import { sideExecutionContent } from "@multica/tutti-agent-gui-host/side-context";
import { isTaskCreationReference, localMessageDisplayContent } from "@multica/tutti-agent-gui-host/local-protocol";
import { isAutomaticLocalDirectory } from "@multica/tutti-agent-gui-host/local-projects";
import type { AgentGuiSession } from "@multica/tutti-agent-gui-host/protocol";
import { projectForDirectory } from "./local-conversation-projects";

export const localConversationKey = (scope: LocalConversationScope) => ["local-conversations", scope.userId, scope.workspaceId] as const;
export const localTargetId = (provider: string) => `local:${provider}`;
export function localProviderId(target: string): LocalProviderId {
  if (target === "local:codex") return "codex";
  if (target === "local:claude") return "claude";
  throw new Error("Select a local Codex or Claude Code provider");
}

/** Translate only at the imported GUI boundary; these records never enter cloud APIs. */
export function projectLocalSession(entry: LocalConversation, scope: LocalConversationScope): AgentGuiSession {
  const last = entry.messages.at(-1);
  return { id: entry.id, workspace_id: scope.workspaceId, creator_id: scope.userId, agent_id: localTargetId(entry.provider),
    title: entry.title, status: entry.archived ? "archived" : "active", has_unread: false, pinned: entry.pinned, project_id: entry.projectId ?? null,
    last_message: last ? { content: localMessageDisplayContent(last), role: last.role, created_at: last.createdAt } : null,
    localDirectory: { cwd: entry.cwd, projectPath: isAutomaticLocalDirectory(entry.cwd) ? null : entry.cwd },
    created_at: entry.createdAt, updated_at: entry.updatedAt };
}
export function projectLocalTurn(entry: LocalConversation, turn: LocalConversationTurn): AgentTask {
  return { id: turn.id, agent_id: turn.remote?.agentId ?? localTargetId(entry.provider), runtime_id: localTargetId(entry.provider),
    issue_id: "", chat_session_id: entry.id, kind: "chat", status: turn.status, priority: 0,
    created_at: turn.createdAt, started_at: turn.createdAt, dispatched_at: turn.createdAt,
    completed_at: turn.completedAt ?? null, result: null, error: turn.error ?? null,
    ...(turn.remote ? { chat_invoked_agent_name: turn.remote.agentName } : {}) };
}

export function createLocalConversationParentService(options: ParentServiceOptions & {
  onLocalSelect(id: string | null, provider?: LocalProviderId): void;
  getSelectionIntent?: () => string;
  onOpenSide?: (id: string, sourceId: string) => void;
  onOpenResource?: (sessionId: string, url: string) => void;
  onLocateSource?: (sessionId: string, turnId?: string, quote?: string) => void;
  storagePrefix?: string;
  locale?: string;
}, client: LocalConversationClient): ReturnType<typeof createAgentGuiParentService> {
  client = getLocalConversationClient(client);
  const attachmentFailures = new Set<string>();
  const scope: LocalConversationScope = { userId: options.userId, workspaceId: options.workspaceId };
  const cloud = createAgentGuiParentService(options);
  const listeners = new Set<(event: AgentGuiHostEvent) => void>();
  const knownTurns = new Map<string, string>();
  const sending = new Set<string>();
  let disposed = false;
  let cloudState: AgentGuiWorkspaceState | undefined;
  let cloudDirty = true;
  let cloudLoad: Promise<AgentGuiWorkspaceState> | undefined;
  let polling = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let selectionSequence = 0;
  const assertCurrent = () => { if (disposed || !options.isCurrent()) throw new Error("This workspace is no longer active"); };
  const publish = (event: AgentGuiHostEvent) => { if (!disposed && options.isCurrent()) listeners.forEach((listener) => listener(event)); };
  const remoteWorkspace = async () => {
    if (!cloudState || cloudDirty) {
      if (!cloudLoad) cloudLoad = cloud.load().then((value) => { cloudState = value; cloudDirty = false; return value; }).finally(() => { cloudLoad = undefined; });
      return cloudLoad;
    }
    return cloudState;
  };
  const local = <M extends import("@multica/tutti-agent-gui-host/local-protocol").LocalConversationMethod>(method: M, params: import("@multica/tutti-agent-gui-host/local-protocol").LocalConversationMethods[M]["params"]) => { assertCurrent(); return client.request(scope, method, params); };
  const read = (id: string) => local("read", { id });
  const fileAttachment = async (id: string): Promise<Attachment> => {
    const file = await local("fileInfo", { id });
    const url = file.url;
    return { id, workspace_id: scope.workspaceId, issue_id: null, comment_id: null, chat_session_id: null, chat_message_id: null, uploader_type: "user", uploader_id: scope.userId,
      filename: file.name, content_type: file.mimeType, size_bytes: file.size, url, download_url: url, markdown_url: url, created_at: new Date().toISOString() };
  };

  async function pollRemote(): Promise<void> {
    if (polling || disposed || !options.isCurrent()) return;
    polling = true;
    let pending = false;
    try {
      const sessions = await local("list", {});
      for (const entry of sessions) for (const turn of entry.turns) {
        if (turn.status !== "running" || !turn.remote || turn.remote.queueOwned || sending.has(turn.id)) continue;
        if (!turn.remote.sessionId || !turn.remote.taskId) {
          await local("remoteUpdate", { id: entry.id, turnId: turn.id, status: "failed", error: "The previous cloud send was not confirmed. Check the agent's cloud chat before retrying.", output: "上次云端发送未确认，请先检查该智能体的云端聊天。" });
          continue;
        }
        pending = true;
        try {
          const [messages, events, tasks] = await Promise.all([
            api.listChatMessagesPage(turn.remote.sessionId, { limit: 100 }),
            api.listTaskMessages(turn.remote.taskId),
            api.listAgentTasksPage(turn.remote.agentId, { limit: 200 }),
          ]);
          assertCurrent();
          const reply = messages.messages.find((message) => message.role === "assistant" && message.task_id === turn.remote!.taskId);
          const task = tasks.tasks.find((task) => task.id === turn.remote!.taskId && task.chat_session_id === turn.remote!.sessionId);
          // Concurrent reads can see the task commit before the assistant row.
          // Keep polling completed tasks until their durable reply is visible.
          const terminal = task && ["failed", "cancelled"].includes(task.status);
          await local("remoteUpdate", { id: entry.id, turnId: turn.id,
            events: events.map((event) => ({ ...event, created_at: event.created_at || new Date().toISOString() })) as LocalConversationEvent[],
            ...(reply ? { output: reply.content, status: reply.failure_reason ? "failed" : "completed" }
              : terminal ? { status: task.status as LocalConversationTurn["status"], ...(task.error ? { error: task.error, output: task.error } : {}) } : {}),
          });
        } catch (error) {
          // Disconnection does not prove the remote execution failed.
          if (!disposed && options.isCurrent()) console.warn("[local-conversations] Cloud result synchronization will retry", error instanceof Error ? error.name : "Error");
        }
      }
    } finally {
      polling = false;
      if (pending && !disposed && options.isCurrent()) timer = setTimeout(() => { timer = undefined; void pollRemote(); }, 2000);
    }
  }
  function scheduleRemote(): void { if (!timer && !polling && !disposed) timer = setTimeout(() => { timer = undefined; void pollRemote().catch(() => {}); }, 100); }
  async function load(): Promise<AgentGuiWorkspaceState> {
    const [remote, providers, sessions, folderProjects] = await Promise.all([remoteWorkspace(), local("providers", {}), local("list", {}), local("folderProjects", {})]);
    assertCurrent(); scheduleRemote();
    return { local: true, queueOwner: "desktop", sideWorkspace: true, sidePane: Boolean(options.storagePrefix), agents: remote.agents, movedQueueRequests: sessions.flatMap((entry) => entry.side ? [entry.side.requestId] : []),
      executionTargets: providers.map((entry) => ({ id: localTargetId(entry.id), name: entry.name, provider: entry.id, iconUrl: "", canInvoke: entry.available, canFork: true, runtimeBound: entry.available, runtimeOnline: entry.available, unavailableReason: entry.available ? undefined : "未在本机安装" })),
      sessions: sessions.map((entry) => projectLocalSession(entry, scope)), folderProjects,
      pendingTasks: sessions.flatMap((entry) => entry.turns.filter((turn) => turn.status === "running").map((turn) => ({ task_id: turn.id, status: "running", chat_session_id: entry.id }))),
    };
  }
  async function detail(id: string): Promise<AgentGuiSessionDetail> {
    const entry = await read(id); assertCurrent(); entry.turns.forEach((turn) => knownTurns.set(turn.id, id));
    const active = entry.turns.find((turn) => turn.status === "running");
    const chinese = (options.locale || document.documentElement.lang || navigator.language).startsWith("zh");
    const failedFiles = new Set<string>();
    const attachmentLoads = new Map<string, Promise<Attachment>>();
    const messages = await Promise.all(entry.messages.map(async (message) => {
      const ids = message.attachmentIds ?? [];
      const results = await Promise.allSettled(ids.map((id) => {
        let pending = attachmentLoads.get(id);
        if (!pending) { pending = fileAttachment(id); attachmentLoads.set(id, pending); }
        return pending;
      }));
      const attachments: Attachment[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") attachments.push(result.value);
        else failedFiles.add(ids[index]!);
      });
      const missing = results.length - attachments.length;
      const note = chinese ? `［${missing} 份附件暂时无法加载，重新打开会话可重试。］` : `[${missing} attachment(s) could not be loaded. Reopen the conversation to retry.]`;
      return { id: message.id, chat_session_id: id, role: message.role,
        content: missing ? `${localMessageDisplayContent(message)}\n\n${note}`.trim() : message.content,
        task_id: message.turnId, created_at: message.createdAt,
        ...(attachments.length ? { attachments } : {}), ...(message.failed ? { failure_reason: "agent_error" } : {}) };
    }));
    assertCurrent();
    if (failedFiles.size) {
      if (!attachmentFailures.has(id)) options.onShowMessage(chinese ? "部分附件暂时无法加载，会话正文已保留。" : "Some attachments could not be loaded. Conversation text is still available.", "warning");
      attachmentFailures.add(id);
    } else attachmentFailures.delete(id);
    return { session: projectLocalSession(entry, scope), model: entry.model, reasoningEffort: entry.reasoningEffort ?? null, promptQueue: entry.promptQueue ?? { revision: 0, paused: false, items: [] },
      backgroundTasks: entry.turns.flatMap((turn) => (turn.backgroundTasks ?? []).filter((task) => !task.ambient).map((task) => ({ turnId: turn.id, task }))),
      questions: entry.turns.flatMap((turn) => (turn.questions ?? []).map((question) => ({ turnId: turn.id, question }))),
      permissionMode: entry.permissionMode ?? (entry.side || entry.forkedFrom || entry.messages.length > 0 || entry.turns.length > 0 ? "default" : undefined),
      tasks: entry.turns.map((turn) => projectLocalTurn(entry, turn)),
      ...(entry.forkedFrom && entry.forkedFromTurnId ? { forkedFrom: { sessionId: entry.forkedFrom, turnId: entry.forkedFromTurnId, targetTurnId: entry.forkedTurnId ?? entry.turns.at(-1)?.id ?? "", operationId: entry.id, createdAt: entry.createdAt } } : {}),
      messages,
      pending: active ? { task_id: active.id, status: "running", created_at: active.createdAt } : {},
    };
  }
  async function referencedContent(content: string, references: { kind: string; id: string }[]): Promise<string> {
    const excerpts: string[] = [];
    for (const reference of references) {
      if (isTaskCreationReference(reference)) continue;
      if (reference.kind === "session") {
        const session = await read(reference.id);
        const messages = session.messages.map((message) => `${message.role}: ${message.content}`).join("\n");
        excerpts.push(`Multica local conversation ${JSON.stringify(session.title)} (id: ${session.id}; workspace: ${scope.workspaceId})\n${messages.slice(-6000)}\n[Conversation snapshot only: saved tool results and attachment contents are not included.${messages.length > 6000 ? " Earlier text omitted." : ""} Use the built-in Multica MCP read_context tool with kind=conversation, source=local and this ID for current messages and pagination.]`);
      } else if (reference.kind === "issue") {
        const issue = await api.getIssue(reference.id); assertCurrent();
        if (issue.workspace_id !== scope.workspaceId) throw new Error("Referenced task is outside this workspace");
        const description = issue.description || "";
        excerpts.push(`Multica task ${issue.identifier} (id: ${issue.id}; workspace: ${scope.workspaceId}) ${issue.title}\n${description.slice(0, 6000)}\n[Task snapshot only: comments, activity and attachment contents are not included.${description.length > 6000 ? " Description excerpt truncated." : ""} Query this task with the built-in Multica MCP read_context tool (kind=task) or Multica CLI for current context.]`);
      }
    }
    return excerpts.length ? `${content}\n\nReferenced context (quoted data):\n${excerpts.join("\n\n---\n\n")}` : content;
  }
  async function invoke(entry: LocalConversation, turns: LocalConversationTurn[], content: string, fileIds: string[]): Promise<void> {
    // The official API has no per-turn system prompt; keep display guidance scoped to this invocation.
    const executionContent = [
      "Multica conversation display capabilities (reply formatting only; follow your existing agent instructions and the user request below):",
      HTML_PREVIEW_INSTRUCTIONS,
      "User request and referenced context:",
      content,
    ].join("\n\n");
    await Promise.all(turns.map(async (turn) => {
      sending.add(turn.id);
      try {
        const wanted = async () => (await read(entry.id)).turns.find((current) => current.id === turn.id)?.status === "running";
        if (!await wanted()) return;
        let sessionId = [...entry.turns].reverse().find((previous) => previous.remote?.agentId === turn.remote!.agentId && previous.remote.sessionId)?.remote?.sessionId;
        if (!sessionId) {
          assertCurrent(); const remote = await api.createChatSession({ agent_id: turn.remote!.agentId, title: entry.title }, options.workspaceSlug); assertCurrent(); sessionId = remote.id;
        }
        await local("remoteUpdate", { id: entry.id, turnId: turn.id, sessionId });
        const attachments: string[] = [];
        for (const id of fileIds) {
          if (!await wanted()) return;
          const file = await local("fileRead", { id }); assertCurrent();
          const bytes = Uint8Array.from(atob(file.data), (character) => character.charCodeAt(0));
          const uploaded = await api.uploadFile(new File([bytes], file.name, { type: file.mimeType })); assertCurrent(); attachments.push(uploaded.id);
        }
        if (!await wanted()) return;
        assertCurrent(); const sent = await api.sendChatMessage(sessionId, executionContent, attachments); assertCurrent();
        await local("remoteUpdate", { id: entry.id, turnId: turn.id, taskId: sent.task_id });
        if (!await wanted()) {
          try {
            const cancelled = await api.cancelTaskById(sent.task_id); assertCurrent();
            await local("remoteUpdate", { id: entry.id, turnId: turn.id, status: cancelled.status === "cancelled" ? "cancelled" : "running" });
          } catch {
            assertCurrent();
            await local("remoteUpdate", { id: entry.id, turnId: turn.id, status: "running" });
            options.onShowMessage("未能确认云端取消，正在继续同步实际执行状态。", "error");
          }
        }
        void options.queryClient.invalidateQueries({ queryKey: chatKeys.sessions(scope.workspaceId) });
      } catch (error) {
        if (!disposed && options.isCurrent() && (await read(entry.id)).turns.find((current) => current.id === turn.id)?.status === "running") await local("remoteUpdate", { id: entry.id, turnId: turn.id, status: "failed", error: error instanceof Error ? error.message : String(error), output: error instanceof Error ? error.message : String(error) });
      } finally { sending.delete(turn.id); }
    }));
    scheduleRemote();
  }
  const receivedOutput = new Set<string>();
  async function request(method: AgentGuiRpcMethod, raw: unknown): Promise<unknown> {
    if (method !== "session.send" && method !== "queue.enqueue") return handleRequest(method, raw);
    const params = raw as Record<string, any>;
    const timing = createLocalTiming({ source: "renderer", conversationId: params.sessionId, requestId: params.requestId ?? params.item?.requestId });
    return timing.measure("renderer.request", () => handleRequest(method, raw));
  }
  async function handleRequest(method: AgentGuiRpcMethod, raw: unknown): Promise<unknown> {
    assertCurrent(); const params = raw as Record<string, any>;
    switch (method) {
      case "queue.enqueue": {
        // Transfer ownership before any asynchronous view-bound preparation.
        const item = params.item as import("@multica/tutti-agent-gui-host/local-protocol").LocalQueuedPrompt;
        const ids = [...new Set(item.references?.filter((reference) => reference.kind === "agent").map((reference) => reference.id) ?? [])];
        if (ids.length) {
          if (item.references?.some(isTaskCreationReference)) throw new Error("New task requires the current local provider");
          item.agents = ids.map((id) => {
            const target = cloudState?.agents.find((value) => value.agent.id === id);
            if (!target?.canInvoke || !target.runtimeBound || target.agent.archived_at) throw new Error("Mentioned agent is not available");
            return { id, name: target.agent.name };
          });
        }
        return local("queueEnqueue", { id: params.sessionId, item, paused: params.paused });
      }
      case "queue.update": return local("queueUpdate", { id: params.sessionId, action: params.action, requestId: params.requestId });
      case "workspace.load": return load();
      case "host.openSide": {
        const side = params.queuedRequestId ? await local("queueSide", { id: params.sessionId, requestId: params.queuedRequestId }) : await local("sideCreate", { id: params.sessionId, requestId: params.requestId, turnId: params.turnId, quote: params.quote, pending: params.pending });
        assertCurrent(); options.onOpenSide?.(side.id, params.sessionId); return projectLocalSession(side, scope);
      }
      case "host.startSide": {
        const side = await read(params.sessionId); const pending = side.side?.pending;
        if (!pending) return undefined;
        await request("session.send", { ...pending, sessionId: side.id });
        await local("sideAccepted", { id: side.id, requestId: pending.requestId }); return undefined;
      }
      case "host.openResource": await read(params.sessionId); options.onOpenResource?.(params.sessionId, params.url); return undefined;
      case "host.locateSource": await read(params.sessionId); options.onLocateSource?.(params.sessionId, params.turnId, params.quote); return undefined;
      case "session.load": return detail(params.sessionId);
      case "interaction.respond": return local("answerQuestion", { id: params.sessionId, turnId: params.turnId, requestId: params.requestId, answers: params.answers });
      case "session.fork": {
        const entry = await local("fork", { id: params.sessionId, turnId: params.turnId, requestId: params.requestId });
        assertCurrent();
        return projectLocalSession(entry, scope);
      }
      case "session.create": {
        let directory: { folderProjectId?: string; directorySourceId?: string } = {};
        if (params.cwd) {
          const projects = await local("folderProjects", {});
          const folder = projectForDirectory(projects, params.cwd);
          if (folder) directory = { folderProjectId: folder.id };
          else {
            const sessions = await local("list", {});
            const source = sessions.find((entry) => entry.cwd === params.cwd && !isAutomaticLocalDirectory(entry.cwd));
            if (!source) throw new Error("Local project directory not found in this workspace");
            directory = { directorySourceId: source.id };
          }
        }
        return projectLocalSession(await local("create", { provider: localProviderId(params.agentId), title: params.title, ...directory }), scope);
      }
      case "session.rename": return projectLocalSession(await local("update", { id: params.sessionId, title: params.title }), scope);
      case "session.pin": return projectLocalSession(await local("update", { id: params.sessionId, pinned: params.pinned }), scope);
      case "session.delete": throw new Error("Archive local conversations from the session list");
      case "session.markRead": case "session.watch": return undefined;
      case "session.send": {
        const entry = await read(params.sessionId);
        const refs = Array.isArray(params.references) ? params.references : [];
        if (refs.some(isTaskCreationReference) && refs.some((ref) => ref.kind === "agent")) throw new Error("New task requires the current local provider (Codex / Claude Code). Remove agent invocation mentions first.");
        const content = await referencedContent(params.content, refs); assertCurrent();
        const files: string[] = Array.isArray(params.attachmentIds) ? params.attachmentIds : [];
        const ids = [...new Set(refs.filter((ref) => ref.kind === "agent").map((ref) => ref.id as string))];
        if (!ids.length) {
          const sent = await local("send", { id: entry.id, content: params.content, prompt: content, references: refs, attachmentIds: files, model: params.model, reasoningEffort: params.reasoningEffort, permissionMode: params.permissionMode, requestId: params.requestId });
          return { message_id: sent.messageId, task_id: sent.turnId, created_at: sent.createdAt };
        }
        const state = await remoteWorkspace();
        const agents = ids.map((id) => {
          const target = state.agents.find((agent) => agent.agent.id === id);
          if (!target?.canInvoke || !target.runtimeBound || target.agent.archived_at) throw new Error("Mentioned agent is not available");
          return { id, name: target.agent.name };
        });
        const accepted = await local("remoteBegin", { id: entry.id, content: params.content, agents, attachmentIds: files, requestId: params.requestId });
        if (accepted.replayed) return { message_id: accepted.messageId, task_id: accepted.turns[0]!.id, created_at: accepted.createdAt };
        accepted.turns.forEach((turn) => sending.add(turn.id));
        void invoke(entry, accepted.turns, entry.side ? sideExecutionContent(entry.side, content) : content, files).catch(() => {});
        return { message_id: accepted.messageId, task_id: accepted.turns[0]!.id, created_at: accepted.createdAt };
      }
      case "session.cancel": {
        const entry = await read(params.sessionId); const turn = entry.turns.find((turn) => turn.id === params.taskId);
        if (!turn) throw new Error("Execution not found");
        if (turn.remote?.taskId) {
          const cancelled = await api.cancelTaskById(turn.remote.taskId); assertCurrent();
          if (cancelled.status === "cancelled") await local("remoteUpdate", { id: entry.id, turnId: turn.id, status: "cancelled" });
          scheduleRemote();
          return projectLocalTurn(await read(entry.id), { ...turn, status: cancelled.status === "cancelled" ? "cancelled" : turn.status });
        }
        return projectLocalTurn(entry, await local("cancel", { id: entry.id, turnId: turn.id }));
      }
      case "task.messages": {
        const id = knownTurns.get(params.taskId); if (!id) throw new Error("Execution is outside the loaded conversations");
        const entry = await read(id);
        const turn = entry.turns.find((turn) => turn.id === params.taskId);
        if (turn?.events.some((event) => ["text", "thinking", "tool_use", "tool_result"].includes(event.type)) && !receivedOutput.has(turn.id)) {
          receivedOutput.add(turn.id);
          if (receivedOutput.size > 512) receivedOutput.delete(receivedOutput.values().next().value!);
          createLocalTiming({ source: "renderer", conversationId: entry.id, turnId: turn.id, requestId: turn.requestId, provider: entry.provider }).mark("renderer.first_output_received");
        }
        return (turn?.events ?? []).map((event) => ({ ...event, task_id: params.taskId, issue_id: "", chat_session_id: entry.id }));
      }
      case "models.list": {
        const result = await local("models", { provider: localProviderId(params.agentId), force: params.force });
        return { ...result, id: "local-models", runtime_id: params.agentId, status: "completed" };
      }
      case "usage.read": return local("usage", { provider: localProviderId(params.agentId), ...(params.sessionId ? { id: params.sessionId } : {}), force: params.force === true });
      case "session.compact": return local("compact", { id: params.sessionId });
      case "storage.read": case "storage.write": return cloud.request(method, { ...params, key: `local-provider:${options.storagePrefix ?? ""}${params.key}` } as never);
      case "host.selectSession": {
        const sequence = ++selectionSequence;
        const intent = options.getSelectionIntent?.();
        const entry = params.sessionId ? await read(params.sessionId) : null;
        assertCurrent();
        if (sequence !== selectionSequence || intent !== options.getSelectionIntent?.()) return undefined;
        if (entry) options.onLocalSelect(entry.id, entry.provider);
        else options.onLocalSelect(null, params.agentId ? localProviderId(params.agentId) : undefined);
        return undefined;
      }
      case "attachment.upload": {
        if (!(params.file instanceof File) || params.file.size > 25 * 1024 * 1024) throw new Error("Invalid file, or file exceeds 25 MB");
        const bytes = new Uint8Array(await params.file.arrayBuffer()); let encoded = "";
        for (let at = 0; at < bytes.length; at += 32768) encoded += String.fromCharCode(...bytes.subarray(at, at + 32768));
        const saved = await local("fileStore", { name: params.file.name, mimeType: params.file.type || "application/octet-stream", data: btoa(encoded) });
        return fileAttachment(saved.id);
      }
      case "attachment.read": { const file = await local("fileRead", { id: params.attachmentId }); return { data: file.data, name: file.name, mimeType: file.mimeType }; }
      case "image.read": {
        const file = await local("imageRead", { id: params.sessionId, path: params.path });
        if (!file.data) throw new Error("Image preview data is unavailable");
        return { data: file.data, name: file.name, mimeType: file.mimeType };
      }
      default: return cloud.request(method, params as never);
    }
  }
  const unsubscribe = client.subscribe((changedScope, id) => {
    if (changedScope.userId !== scope.userId || changedScope.workspaceId !== scope.workspaceId) return;
    void options.queryClient.invalidateQueries({ queryKey: localConversationKey(scope) });
    publish({ type: "invalidate", scope: "session", sessionId: id }); publish({ type: "invalidate", scope: "workspace" });
  });
  const unsubscribeCloud = cloud.subscribe((event) => { if (event.type === "invalidate" && event.scope === "workspace") { cloudDirty = true; publish(event); } });
  return { load, request: request as <M extends AgentGuiRpcMethod>(method: M, params: AgentGuiRpcMethods[M]["params"]) => Promise<AgentGuiRpcMethods[M]["result"]>,
    publish, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reconnect: () => { cloudDirty = true; cloud.reconnect(); scheduleRemote(); publish({ type: "invalidate", scope: "workspace" }); },
    dispose: () => { disposed = true; if (timer) clearTimeout(timer); unsubscribe(); unsubscribeCloud(); cloud.dispose(); listeners.clear(); },
  };
}
