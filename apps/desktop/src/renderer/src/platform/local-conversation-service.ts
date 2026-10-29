import { createLocalTiming } from "@multica/tutti-agent-gui-host/local-timing";
import { getLocalConversationClient } from "./local-conversation-client";
import { api } from "@multica/core/api";
import type { AgentTask, Attachment } from "@multica/core/types";
import { createAgentGuiParentService, type ParentServiceOptions } from "@multica/views/conversation-flow/service";
import type { AgentGuiHostEvent, AgentGuiRpcMethod, AgentGuiRpcMethods, AgentGuiSessionDetail, AgentGuiWorkspaceState } from "@multica/tutti-agent-gui-host/protocol";
import type { LocalConversation, LocalConversationClient, LocalConversationScope, LocalConversationTurn, LocalProviderId } from "@multica/core/local-conversation/protocol";
import { sideExecutionContent } from "@multica/tutti-agent-gui-host/side-context";
import { isTaskCreationReference, localMessageDisplayContent } from "@multica/core/local-conversation/protocol";
import { isAutomaticLocalDirectory } from "@multica/tutti-agent-gui-host/local-projects";
import type { AgentGuiSession } from "@multica/tutti-agent-gui-host/protocol";
import { projectForDirectory } from "./local-conversation-projects";
import { blobBase64 } from "./local-preview-file";

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
  getSelectedSessionId?: () => string | null;
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
  let disposed = false;
  let cloudState: AgentGuiWorkspaceState | undefined;
  let cloudDirty = true;
  let cloudLoad: Promise<AgentGuiWorkspaceState> | undefined;
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
  const local = <M extends import("@multica/core/local-conversation/protocol").LocalConversationMethod>(method: M, params: import("@multica/core/local-conversation/protocol").LocalConversationMethods[M]["params"]) => { assertCurrent(); return client.request(scope, method, params); };
  const read = (id: string) => local("read", { id });
  const fileAttachment = async (id: string): Promise<Attachment> => {
    const file = await local("fileInfo", { id });
    const url = file.url;
    return { id, workspace_id: scope.workspaceId, issue_id: null, comment_id: null, chat_session_id: null, chat_message_id: null, uploader_type: "user", uploader_id: scope.userId,
      filename: file.name, content_type: file.mimeType, size_bytes: file.size, url, download_url: url, markdown_url: url, created_at: new Date().toISOString() };
  };

  async function load(): Promise<AgentGuiWorkspaceState> {
    const [remote, providers, runtime, folderProjects] = await Promise.all([remoteWorkspace(), local("providers", {}), local("runtimeState", {}), local("folderProjects", {})]);
    const loaded = options.queryClient.getQueriesData<import("./local-conversation-pages").ConversationPageGroup[]>({ queryKey: [...localConversationKey(scope), "pages"] });
    const summaries = loaded.flatMap(([, groups]) => groups?.flatMap((group) => group.sessions) ?? []);
    // Standalone hosts (e.g. Side panes) share the page cache. They never request later pages.
    if (!loaded.length) {
      const pages = await Promise.all([...folderProjects.map((project) => project.id), null].map((folderProjectId) => local("listPage", { folderProjectId })));
      summaries.push(...pages.flatMap((page) => page.sessions));
    }
    const selectedId = options.getSelectedSessionId?.();
    if (selectedId && !summaries.some((entry) => entry.id === selectedId)) summaries.push(await read(selectedId));
    const sessions = [...new Map(summaries.map((entry) => [entry.id, entry])).values()];
    assertCurrent();
    return { local: true, composerDraftScope: JSON.stringify([api.getBaseUrl(), options.storagePrefix ?? ""]), queueOwner: "desktop", sideWorkspace: true, sidePane: Boolean(options.storagePrefix), agents: remote.agents, movedQueueRequests: runtime.movedQueueRequests,
      executionTargets: providers.map((entry) => ({ id: localTargetId(entry.id), name: entry.name, provider: entry.id, iconUrl: "", canInvoke: entry.available, canFork: true, runtimeBound: entry.available, runtimeOnline: entry.available, unavailableReason: entry.available ? undefined : "未在本机安装" })),
      sessions: sessions.map((entry) => projectLocalSession(entry, scope)), folderProjects,
      pendingTasks: runtime.pendingTasks,
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
      const sourceLabel = message.origin ? `[${chinese ? (message.steered ? "来自主会话的引导" : "主会话发起") : (message.steered ? "Steered from main conversation" : "Sent from main conversation")}](mention://agent-session/${encodeURIComponent(message.origin.conversationId)}?workspaceId=${encodeURIComponent(scope.workspaceId)})` : "";
      const displayed = [sourceLabel, localMessageDisplayContent(message), ...(missing ? [note] : [])].filter(Boolean).join("\n\n");
      return { id: message.id, chat_session_id: id, role: message.role,
        content: displayed,
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
        const item = params.item as import("@multica/core/local-conversation/protocol").LocalQueuedPrompt;
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
            const source = !isAutomaticLocalDirectory(params.cwd) ? await local("directorySource", { cwd: params.cwd }) : null;
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
        const accepted = await local("remoteSend", { id: entry.id, content: params.content, prompt: entry.side ? sideExecutionContent(entry.side, content) : content, agents, attachmentIds: files, requestId: params.requestId });
        return { message_id: accepted.messageId, task_id: accepted.turns[0]!.id, created_at: accepted.createdAt };
      }
      case "session.cancel": {
        const entry = await read(params.sessionId); const turn = entry.turns.find((turn) => turn.id === params.taskId);
        if (!turn) throw new Error("Execution not found");
        return projectLocalTurn(await read(entry.id), await local("cancel", { id: entry.id, turnId: turn.id }));
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
        return fileAttachment(await client.files.upload(scope, params.file));
      }
      case "attachment.read": {
        const file = await local("fileInfo", { id: params.attachmentId });
        return { data: await blobBase64(await client.files.read(scope, params.attachmentId)), name: file.name, mimeType: file.mimeType };
      }
      case "image.read": {
        const file = await local("imageRead", { id: params.sessionId, path: params.path });
        if (!file.fileRef) throw new Error("Image preview data is unavailable");
        return { data: await blobBase64(await client.files.read(scope, file.fileRef)), name: file.name, mimeType: file.mimeType };
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
  const unsubscribePages = options.queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (event.type === "updated" && event.action.type === "success" && key[0] === "local-conversations" && key[1] === scope.userId && key[2] === scope.workspaceId && key[3] === "pages") publish({ type: "invalidate", scope: "workspace" });
  });
  return { load, request: request as <M extends AgentGuiRpcMethod>(method: M, params: AgentGuiRpcMethods[M]["params"]) => Promise<AgentGuiRpcMethods[M]["result"]>,
    publish, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reconnect: () => { cloudDirty = true; cloud.reconnect(); publish({ type: "invalidate", scope: "workspace" }); },
    dispose: () => { disposed = true; unsubscribe(); unsubscribeCloud(); unsubscribePages(); cloud.dispose(); listeners.clear(); },
  };
}
