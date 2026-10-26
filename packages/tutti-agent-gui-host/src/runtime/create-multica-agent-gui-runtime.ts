import { createLocalTiming, createLocalPresentationTiming } from "../local-timing";
import {
  createAgentActivitySnapshotProjector,
  createAgentSessionEngine,
  type AgentActivityComposerOptions,
  type AgentActivityDurableMessage,
  type AgentActivitySendInput,
  type AgentActivitySession,
  type AgentActivitySnapshot,
  type AgentSessionActivateEffectInput,
  type EngineExtensionCommand,
  type EngineTypedCommandPort,
} from "@tutti-os/agent-activity-core";
import type { AgentGUIRuntime } from "@tutti-os/agent-gui";
import { extractRichTextMentionsFromContent } from "@tutti-os/ui-rich-text/core";
import { contentReferencesAttachment } from "@multica/core/types/attachment-url";
import type { Attachment, ChatSession } from "@multica/core/types";
import type {
  AgentGuiExecutionTarget,
  AgentGuiContextReference,
  AgentGuiInitSnapshot,
  AgentGuiRpcClient,
  AgentGuiSessionDetail,
  AgentGuiWorkspaceState,
  AgentGuiTaskMessagePayload,
} from "../protocol";
import { executionTargets } from "../protocol";
import { ModelPreferences } from "./model-preferences";
import { PermissionPreferences } from "./permission-preferences";
import { isLocalPermissionMode, type LocalPermissionMode } from "../local-protocol";
import { RuntimeLedger } from "./ledger";
import { composerOptions, projectDetail, projectPendingSession, projectSession } from "./projection";
import { createDesktopQueueEngine } from "./desktop-queue-engine";
import { snapshotPromptQueues } from "./saved-prompt-queues";

const STORAGE_KEY = "runtime-ledger-v1";

export class MulticaAgentGuiError extends Error {
  constructor(message: string, public code: string, public status?: number) {
    super(message);
    this.name = "MulticaAgentGuiError";
  }
}

export function unsupported(capability: string): never {
  throw new MulticaAgentGuiError(`${capability} is not supported by this Multica connection.`, "unsupported");
}

export function createMulticaAgentGuiRuntime(client: AgentGuiRpcClient, init: AgentGuiInitSnapshot) {
  const workspaceId = init.workspaceId;
  const presentationTiming = createLocalPresentationTiming();
  const ledger = new RuntimeLedger();
  const modelPreferences = new ModelPreferences();
  const modelListeners = new Set<() => void>();
  let modelRevision = 0;
  let modelWrites: Promise<void> = Promise.resolve();
  const modelHydration = client.request("storage.read", { key: "model-preferences-v1" }).then((value) => { modelPreferences.hydrate(value); });
  void modelHydration.catch(() => {});
  const permissionPreferences = new PermissionPreferences();
  const permissionListeners = new Set<() => void>();
  let permissionRevision = 0;
  let permissionWrites: Promise<void> = Promise.resolve();
  const permissionHydration = init.local ? client.request("storage.read", { key: "permission-preferences-v1" }).then((value) => { permissionPreferences.hydrate(value); }) : Promise.resolve();
  void permissionHydration.catch(() => {});
  const details = new Map<string, AgentGuiSessionDetail>();
  const transcripts = new Map<string, Map<string, AgentGuiTaskMessagePayload[]>>();
  const attachments = new Map<string, Attachment>();
  const sessionLoads = new Map<string, Promise<AgentActivitySession>>();
  const dirtySessions = new Set<string>();
  const taskLoads = new Map<string, Promise<void>>();
  const dirtyTasks = new Map<string, { sessionId: string; taskId: string }>();
  const watched = new Map<string, number>();
  const workspaceListeners = new Set<() => void>();
  const eventListeners = new Set<(event: unknown) => void>();
  const sendPromises = new Map<string, Promise<unknown>>();
  const pendingIdentities = new Map<string, { promise: Promise<string>; resolve(id: string): void; reject(error: unknown): void }>();
  let workspace: AgentGuiWorkspaceState = { agents: init.agents, executionTargets: init.executionTargets, local: init.local, sessions: init.sessions, pendingTasks: init.pendingTasks };
  let workspaceLoad: Promise<AgentActivitySnapshot> | null = null;
  let workspaceDirty = false;
  let disposed = false;
  let initialized = false;
  let historyRevision = 0;
  let saveQueue = Promise.resolve();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let watchQueue = Promise.resolve();
  let latestGeneration = init.generation ?? 0;
  let attention = { completed: { readIds: [] as string[], unreadIds: [] as string[] }, failed: { readIds: [] as string[], unreadIds: [] as string[] } };

  const persist = () => {
    const value = ledger.serialize();
    const next = saveQueue.catch(() => {}).then(() => client.request("storage.write", { key: STORAGE_KEY, value }));
    saveQueue = next;
    return next;
  };
  const schedulePersist = () => {
    if (saveTimer || disposed) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist().catch(reportError);
    }, 200);
  };
  const commandPort: EngineTypedCommandPort = {
    kind: "typed",
    effects: {
      activateSession: (input, options) => activate(input, options.signal),
      sendInput: (input, options) => send(input, options.signal),
      cancelTurn: async (input, options) => {
        scope(input.workspaceId);
        const result = await client.request("session.cancel", {
          sessionId: await backendSessionId(input.agentSessionId), taskId: input.turnId,
        }, { signal: options.signal });
        const detail = details.get(input.agentSessionId);
        if (detail) {
          detail.tasks = [...(detail.tasks ?? []).filter((task) => task.id !== result.id), result];
        }
        await loadFreshSession(input.agentSessionId, options.signal);
        const turn = Object.values(engine.getSnapshot().sessionLifecycle.turnsById)
          .find((entry) => entry.agentSessionId === input.agentSessionId && entry.turnId === input.turnId);
        if (!turn) throw new MulticaAgentGuiError("The cancellation was accepted, but its run is still synchronizing.", "cancel_pending_sync");
        return turn.phase === "settled"
          ? { cancel: { canceled: turn.outcome === "canceled", reason: turn.outcome === "canceled" ? "turn_canceled" : "already_settled" }, turn }
          : { cancel: { canceled: false, reason: "cancel_requested" }, turn: { ...turn, phase: "settling", outcome: null } };
      },
      deleteSessions: async () => unsupported("Recoverable session deletion"),
      respondToInteraction: async (input, options) => {
        scope(input.workspaceId);
        if (!init.local || input.action !== "submit" || !input.payload?.answersByQuestionId) unsupported("This interaction response");
        await client.request("interaction.respond", {
          sessionId: await backendSessionId(input.agentSessionId), turnId: input.turnId, requestId: input.requestId,
          answers: input.payload.answersByQuestionId as Record<string, string | string[]>,
        }, { signal: options.signal });
        return { session: await loadFreshSession(input.agentSessionId, options.signal) };
      },
      renameSession: async (input, options) => {
        scope(input.workspaceId);
        const session = await client.request("session.rename", {
          sessionId: await backendSessionId(input.agentSessionId), title: input.title,
        }, { signal: options?.signal });
        return { session: replaceMetadata(session) };
      },
      setSessionPinned: async (input, options) => {
        scope(input.workspaceId);
        const session = await client.request("session.pin", {
          sessionId: await backendSessionId(input.agentSessionId), pinned: input.pinned,
        }, { signal: options?.signal });
        return { session: replaceMetadata(session) };
      },
      updateSessionSettings: async (input) => {
        scope(input.workspaceId);
        const session = engine.getSnapshot().sessionLifecycle.sessionsById[input.agentSessionId];
        if (!session?.agentTargetId) throw new MulticaAgentGuiError("Conversation is not loaded.", "session_not_loaded");
        if (Object.keys(input.settings).some((key) => key !== "model")) unsupported("Non-model conversation settings");
        await setModelSelection(session.agentTargetId, input.agentSessionId, input.settings.model ?? null);
        return { agentSessionId: input.agentSessionId, session: projectSnapshot(engine.getSnapshot()).sessions.find((entry) => entry.agentSessionId === input.agentSessionId) };
      },
    },
    execute: executeExtension,
  };
  const baseEngine = createAgentSessionEngine({
    identity: { workspaceId, origin: "multica" },
    clock: { nowUnixMs: () => Date.now() },
    scheduler: { schedule: (delay, callback) => {
      const timer = setTimeout(callback, delay);
      return { cancel: () => clearTimeout(timer) };
    } },
    commandPort,
  });
  const desktopQueue = createDesktopQueueEngine(baseEngine, {
    enabled: () => workspace.queueOwner === "desktop",
    enqueue: enqueueDesktop,
    update: async (id, action, requestId) => client.request("queue.update", { sessionId: await backendSessionId(id), action, requestId }),
    error: reportError,
  });
  const engine = desktopQueue.engine;
  const projectSnapshot = createAgentActivitySnapshotProjector(workspaceId);
  let queuesReady = false;
  let queueSaveErrorReported = false;
  const unrestoredQueueSessionIds = new Set<string>();
  let lastPromptQueue = engine.getSnapshot().promptQueue;
  const unsubscribeQueues = engine.subscribe((state) => {
    if (workspace.queueOwner === "desktop") return;
    if (!queuesReady || state.promptQueue === lastPromptQueue) return;
    lastPromptQueue = state.promptQueue;
    ledger.savePromptQueues(state.promptQueue, unrestoredQueueSessionIds, [...attachments.values()]);
    // Queue edits must reach storage immediately, including delete/edit. A
    // streaming-history debounce can be lost when the window closes.
    void persist().then(() => { queueSaveErrorReported = false; }, (error: unknown) => {
      reportError(error);
      if (disposed || queueSaveErrorReported) return;
      queueSaveErrorReported = true;
      void client.request("host.showMessage", {
        message: init.locale === "zh-CN" ? "未能保存排队消息，关闭窗口前请保留消息内容。" : "Could not save queued messages. Keep a copy before closing the window.",
        tone: "error",
      }).catch(reportError);
    });
  });

  async function restorePromptQueues() {
    if (workspace.queueOwner === "desktop") {
      for (const queue of ledger.savedPromptQueues()) {
        try {
          await loadFreshSession(queue.agentSessionId);
          for (const prompt of queue.prompts) {
            const receipt = ledger.submission(prompt.clientSubmitId || prompt.id);
            if (receipt?.state === "accepted") continue;
            // Ambiguous old delivery must be inspected rather than replayed.
            if (receipt) throw unconfirmed();
            await enqueueDesktop({ ...prompt, agentSessionId: queue.agentSessionId, clientSubmitId: prompt.clientSubmitId || prompt.id }, true);
          }
        } catch (error) {
          unrestoredQueueSessionIds.add(queue.agentSessionId); reportError(error);
          void client.request("host.showMessage", { message: init.locale === "zh-CN"
            ? "部分旧排队消息未能确认，原内容已保留。请先检查会话记录，避免重复发送。"
            : "Some saved queued messages could not be confirmed. Their contents are preserved. Check the conversation before resending.", tone: "warning" }).catch(reportError);
        }
      }
      ledger.savePromptQueues({ nextCommandSequence: 0, recordsBySessionId: {} }, unrestoredQueueSessionIds, []);
      queuesReady = true; await persist(); return;
    }
    for (const queue of ledger.savedPromptQueues()) {
      const prompts = queue.prompts.filter((prompt) => ledger.submission(prompt.clientSubmitId || prompt.id)?.state !== "accepted" && !workspace.movedQueueRequests?.includes(`side:${ledger.serverId(queue.agentSessionId)}:${prompt.clientSubmitId || prompt.id}`));
      if (!prompts.length) continue;
      let session: AgentActivitySession;
      try { session = await loadFreshSession(queue.agentSessionId); }
      catch (error) {
        unrestoredQueueSessionIds.add(queue.agentSessionId);
        reportError(error);
        continue;
      }
      // Block drain while recreating submit identities, then pause the whole
      // restored queue before making the runtime available again.
      engine.dispatch({ type: "session/runtimeAvailabilityChanged", agentSessionId: queue.agentSessionId,
        availability: { state: "blocked", reason: "transport_reconnecting" } });
      for (const prompt of prompts) engine.submitPrompt({
        agentSessionId: queue.agentSessionId, clientSubmitId: prompt.clientSubmitId || prompt.id,
        content: [...prompt.content],
        ...(prompt.runtimeContent ? { runtimeContent: [...prompt.runtimeContent] } : {}),
        ...(prompt.displayPrompt ? { displayPrompt: prompt.displayPrompt } : {}),
        ...(prompt.requiredSettingsPatch ? { requiredSettingsPatch: prompt.requiredSettingsPatch } : {}),
      });
      engine.dispatch({ type: "queue/suspended", agentSessionId: queue.agentSessionId, reason: "user_stop" });
      markAvailability(session);
    }
    queuesReady = true;
    lastPromptQueue = engine.getSnapshot().promptQueue;
    ledger.savePromptQueues(lastPromptQueue, unrestoredQueueSessionIds, [...attachments.values()]);
    await persist();
  }

  function scope(id: string) {
    if (disposed) throw new MulticaAgentGuiError("This Agent GUI connection has closed.", "disposed");
    if (id !== workspaceId) throw new MulticaAgentGuiError("The workspace changed.", "workspace_mismatch");
  }
  function descriptor(id: string): AgentGuiExecutionTarget {
    const result = executionTargets(workspace).find((entry) => entry.id === id);
    if (!result) throw new MulticaAgentGuiError("This agent is not available.", "agent_unavailable");
    return result;
  }
  function resolvedServerId(guiId: string): string | null {
    const serverId = ledger.serverId(guiId);
    return serverId !== guiId || workspace.sessions.some((session) => session.id === guiId) ? serverId : null;
  }
  async function backendSessionId(guiId: string): Promise<string> {
    const id = resolvedServerId(guiId);
    if (id) return id;
    const pending = pendingIdentities.get(guiId);
    if (pending) return pending.promise;
    throw new MulticaAgentGuiError("This conversation has not been created by Multica.", "session_not_ready");
  }
  function assertInvoke(agentId: string, sessionId?: string) {
    const agent = descriptor(agentId);
    if (!agent.canInvoke) {
      throw new MulticaAgentGuiError(agent.unavailableReason || "You cannot invoke this agent.", "invocation_not_allowed", 403);
    }
    if (!agent.runtimeBound) throw new MulticaAgentGuiError("This agent has no runtime.", "runtime_required");
    const session = sessionId ? details.get(sessionId)?.session
      ?? workspace.sessions.find((entry) => entry.id === ledger.serverId(sessionId)) : undefined;
    if (session?.status === "archived") {
      throw new MulticaAgentGuiError("This conversation is archived.", "session_archived");
    }
    return agent;
  }
  function selectedModel(agentId: string, sessionId?: string | null) {
    const session = sessionId ? details.get(sessionId)?.session ?? workspace.sessions.find((entry) => entry.id === ledger.serverId(sessionId)) : undefined;
    if (session && session.agent_id !== agentId) return null;
    const serverId = sessionId ? ledger.serverId(sessionId) : null;
    if (modelPreferences.has(agentId, serverId)) return modelPreferences.get(agentId, serverId);
    return sessionId ? details.get(sessionId)?.model ?? null : null;
  }
  function withModel(session: AgentActivitySession): AgentActivitySession {
    const agent = executionTargets(workspace).find((entry) => entry.id === session.agentTargetId);
    return { ...session, settings: { ...session.settings, model: selectedModel(session.agentTargetId ?? "", session.agentSessionId) ?? agent?.model ?? null } };
  }
  function isModelSelectionBusy(sessionId?: string | null) {
    if (!sessionId) return false;
    const canonical = engine.getSnapshot().sessionLifecycle.sessionsById[sessionId];
    return Boolean(canonical?.activeTurnId || workspace.pendingTasks?.some((task) => task.chat_session_id === ledger.serverId(sessionId)));
  }
  function selectedPermission(agentId: string, sessionId?: string | null): LocalPermissionMode {
    const detail = sessionId ? details.get(sessionId) : undefined;
    const session = sessionId ? detail?.session ?? workspace.sessions.find((entry) => entry.id === ledger.serverId(sessionId)) : undefined;
    if (session && session.agent_id !== agentId) return "default";
    const saved = permissionPreferences.get(agentId, sessionId ? ledger.serverId(sessionId) : null) ?? detail?.permissionMode;
    if (saved !== undefined) return saved;
    // A remembered default only applies to drafts and confirmed empty conversations.
    if (sessionId && (!detail || detail.messages.length > 0 || (detail.tasks?.length ?? 0) > 0 || detail.pending.task_id || detail.forkedFrom)) return "default";
    return permissionPreferences.get(agentId) ?? "default";
  }
  function setPermissionSelection(agentId: string, sessionId: string | null | undefined, mode: LocalPermissionMode) {
    const operation = permissionWrites.catch(() => {}).then(async () => {
      await permissionHydration;
      scope(workspaceId);
      if (!init.local || !isLocalPermissionMode(mode)) throw new MulticaAgentGuiError("Invalid local permission mode.", "invalid_permission_mode");
      assertInvoke(agentId, sessionId ?? undefined);
      const session = sessionId ? details.get(sessionId)?.session ?? workspace.sessions.find((entry) => entry.id === ledger.serverId(sessionId)) : undefined;
      if (sessionId && (!session || session.agent_id !== agentId)) throw new MulticaAgentGuiError("The permission scope does not belong to this provider.", "invalid_session", 409);
      if (isModelSelectionBusy(sessionId)) throw new MulticaAgentGuiError("Wait for this run to finish before changing permissions.", "run_in_progress", 409);
      const next = new PermissionPreferences();
      next.hydrate(permissionPreferences.serialize());
      next.set(agentId, null, mode);
      if (sessionId) next.set(agentId, ledger.serverId(sessionId), mode);
      await client.request("storage.write", { key: "permission-preferences-v1", value: next.serialize() });
      scope(workspaceId);
      permissionPreferences.hydrate(next.serialize());
      permissionRevision++;
      permissionListeners.forEach((listener) => listener());
    });
    permissionWrites = operation;
    return operation;
  }
  function setModelSelection(agentId: string, sessionId: string | null | undefined, model: string | null) {
    const operation = modelWrites.catch(() => {}).then(async () => {
      await modelHydration;
      scope(workspaceId);
      assertInvoke(agentId, sessionId ?? undefined);
      const session = sessionId ? details.get(sessionId)?.session ?? workspace.sessions.find((entry) => entry.id === ledger.serverId(sessionId)) : undefined;
      if (sessionId && (!session || session.agent_id !== agentId)) throw new MulticaAgentGuiError("The model scope does not belong to this agent.", "invalid_session", 409);
      if (isModelSelectionBusy(sessionId)) throw new MulticaAgentGuiError("Wait for this run to finish before changing its model.", "run_in_progress", 409);
      const next = new ModelPreferences();
      next.hydrate(modelPreferences.serialize());
      next.set(agentId, sessionId ? ledger.serverId(sessionId) : null, model);
      await client.request("storage.write", { key: "model-preferences-v1", value: next.serialize() });
      scope(workspaceId);
      modelPreferences.hydrate(next.serialize());
      if (sessionId) {
        const current = projectSnapshot(engine.getSnapshot()).sessions.find((entry) => entry.agentSessionId === sessionId);
        if (current) engine.dispatch({ type: "session/upserted", session: withModel(current) });
      }
      modelRevision++;
      modelListeners.forEach((listener) => listener());
    });
    modelWrites = operation;
    return operation;
  }
  function markAvailability(session: AgentActivitySession) {
    const agent = executionTargets(workspace).find((entry) => entry.id === session.agentTargetId);
    engine.dispatch({
      type: "session/runtimeAvailabilityChanged", agentSessionId: session.agentSessionId,
      availability: agent?.canInvoke && agent.runtimeBound && session.resumable
        ? { state: "available" }
        : { state: "blocked", reason: "agent_capability_unavailable" },
    });
  }
  function replaceMetadata(session: ChatSession): AgentActivitySession {
    const id = ledger.guiId(session.id);
    const detail = details.get(id);
    if (detail) detail.session = session;
    workspace = { ...workspace, sessions: [...workspace.sessions.filter((entry) => entry.id !== session.id), session] };
    const value = detail
      ? projectDetail(detail, executionTargets(workspace).find((entry) => entry.id === session.agent_id), transcripts.get(id) ?? new Map(), ledger, init.locale).session
      : projectSession(session, executionTargets(workspace).find((entry) => entry.id === session.agent_id), ledger);
    engine.dispatch({ type: "session/upserted", session: withModel(value) });
    markAvailability(value);
    for (const listener of workspaceListeners) listener();
    return withModel(value);
  }
  function reportError(error: unknown) {
    if (disposed) return;
    console.error("[multica-agent-gui]", error);
  }
  function syncWatch() {
    const sessionIds = [...watched.keys()].map(resolvedServerId).filter((id): id is string => Boolean(id));
    watchQueue = watchQueue.catch(() => {}).then(() => client.request("session.watch", { sessionIds }));
    return watchQueue;
  }
  async function loadWorkspace(): Promise<AgentActivitySnapshot> {
    scope(workspaceId);
    if (workspaceLoad) return workspaceLoad;
    workspaceLoad = (async () => {
      const previousPending = workspace.pendingTasks;
      workspace = await client.request("workspace.load", {});
      scope(workspaceId);
      const pendingBySession = new Map<string, NonNullable<AgentGuiWorkspaceState["pendingTasks"]>[number]>();
      for (const task of workspace.pendingTasks ?? []) {
        const current = pendingBySession.get(task.chat_session_id);
        if (!current || current.status === "queued" && task.status !== "queued") pendingBySession.set(task.chat_session_id, task);
      }
      const sessions = workspace.sessions.map((session) => {
        const id = ledger.guiId(session.id);
        const detail = details.get(id);
        if (detail) {
          detail.session = session;
          return projectDetail(detail, executionTargets(workspace).find((entry) => entry.id === session.agent_id), transcripts.get(id) ?? new Map(), ledger, init.locale).session;
        }
        return projectPendingSession(session, executionTargets(workspace).find((entry) => entry.id === session.agent_id), ledger, pendingBySession.get(session.id));
      });
      engine.dispatch({ type: "session/snapshotReceived", sessions: sessions.map(withModel) });
      for (const session of sessions) markAvailability(session);
      // A disappearing aggregate row does not prove a completion outcome.
      // Reconcile that previously live conversation against real detail once.
      if (workspace.pendingTasks !== undefined) {
        const refresh = new Set((previousPending ?? [])
          .filter((task) => !workspace.pendingTasks!.some((next) => next.task_id === task.task_id && next.status === task.status))
          .map((task) => ledger.guiId(task.chat_session_id)));
        for (const task of workspace.pendingTasks) {
          const id = ledger.guiId(task.chat_session_id);
          if (details.has(id) && !(previousPending ?? []).some((previous) => previous.task_id === task.task_id && previous.status === task.status)) refresh.add(id);
        }
        for (const id of refresh) void loadSession(id).catch(reportError);
      }
      for (const listener of workspaceListeners) listener();
      return projectSnapshot(engine.getSnapshot());
    })().finally(() => {
      workspaceLoad = null;
      if (workspaceDirty && !disposed) {
        workspaceDirty = false;
        void loadWorkspace().catch(reportError);
      }
    });
    return workspaceLoad;
  }

  async function loadSession(guiId: string, signal?: AbortSignal): Promise<AgentActivitySession> {
    scope(workspaceId);
    const current = sessionLoads.get(guiId);
    if (current) return current;
    const operation = (async () => {
      const detail = await client.request("session.load", { sessionId: await backendSessionId(guiId) }, { signal });
      scope(detail.session.workspace_id);
      const old = details.get(guiId);
      // A cancel response may arrive before the server's history projection.
      if (old?.tasks) detail.tasks = [...new Map([...old.tasks, ...(detail.tasks ?? [])].map((task) => [task.id, task])).values()];
      details.set(guiId, detail);
      registerAttachments(detail.messages.flatMap((message) => message.attachments ?? []));
      const ids = [...new Set([
        ...detail.messages.map((message) => message.task_id).filter((id): id is string => Boolean(id)),
        ...(detail.pending.task_id ? [detail.pending.task_id] : []),
      ])];
      const taskMessages = new Map<string, AgentGuiTaskMessagePayload[]>();
      await parallelMap(ids, async (taskId) => {
        taskMessages.set(taskId, await client.request("task.messages", { taskId }, { signal }));
      });
      scope(workspaceId);
      for (const [taskId, messages] of taskMessages) {
        const cached = transcripts.get(guiId)?.get(taskId) ?? [];
        taskMessages.set(taskId, mergeTaskMessages(cached, messages));
      }
      transcripts.set(guiId, taskMessages);
      return applyDetail(guiId);
    })().finally(() => {
      sessionLoads.delete(guiId);
      if (dirtySessions.delete(guiId) && watched.has(guiId) && !disposed) {
        void loadSession(guiId).catch(reportError);
      }
      // A new session read owns its deferred task refreshes. Iterate a finite
      // snapshot: loadTask can retain the same dirty key while another read is
      // pending, and a live Map iterator would revisit that key forever.
      for (const [key, task] of [...dirtyTasks]) {
        if (task.sessionId === guiId && !disposed && !sessionLoads.has(guiId)) {
          dirtyTasks.delete(key);
          void loadTask(task.sessionId, task.taskId).catch(reportError);
        }
      }
    });
    sessionLoads.set(guiId, operation);
    return operation;
  }

  async function loadFreshSession(guiId: string, signal?: AbortSignal) {
    await sessionLoads.get(guiId)?.catch(() => {});
    return loadSession(guiId, signal);
  }

  function applyDetail(guiId: string): AgentActivitySession {
    const detail = details.get(guiId)!;
    desktopQueue.receive(guiId, detail.promptQueue);
    const result = projectDetail(detail, executionTargets(workspace).find((entry) => entry.id === detail.session.agent_id), transcripts.get(guiId) ?? new Map(), ledger, init.locale);
    const unsettled = new Set(Object.values(engine.getSnapshot().sessionLifecycle.turnsById)
      .filter((turn) => turn.agentSessionId === guiId && turn.phase !== "settled").map((turn) => turn.turnId));
    engine.dispatch({
      type: "session/historyAuthoritativeSnapshotReceived", workspaceId,
      agentSessionId: guiId, childSessions: [], historyRevision: ++historyRevision,
      session: withModel(result.session), turns: result.turns, messages: result.messages,
      sessionMessageWindows: [{ agentSessionId: guiId, hasOlderMessages: false, oldestLoadedVersion: result.messages.length ? Math.min(...result.messages.map((message) => message.version)) : null }],
    });
    // A same-timestamp terminal result can leave the engine's previous active
    // pointer intact. Fence that specific transition once: replaying every
    // historical settlement would itself request another live reconciliation.
    for (const turn of result.turns) {
      if (turn.phase === "settled" && engine.getSnapshot().sessionLifecycle.sessionsById[guiId]?.activeTurnId === turn.turnId) engine.dispatch({
        type: "turn/projectionReceived", workspaceId, turn, activeTurnId: null,
        hostFencedSameTurnSettlement: true,
      });
    }
    // History snapshots never raise attention. A run this runtime saw unsettled
    // that history now settles is a real completion: replay it as an accepted
    // live completion so the conversation list shows its unread mark.
    for (const turn of Object.values(engine.getSnapshot().sessionLifecycle.turnsById)) {
      if (turn.agentSessionId === guiId && turn.phase === "settled" && unsettled.has(turn.turnId)) engine.dispatch({
        type: "turn/upserted", live: true, replayAcceptedLiveCompletion: true, turn,
      });
    }
    if (init.local) for (const turn of result.turns) {
      const events = transcripts.get(guiId)?.get(turn.turnId) ?? [];
      const hasOutput = events.some((event) => ["text", "thinking", "tool_use", "tool_result"].includes(event.type))
        || detail.messages.some((message) => message.task_id === turn.turnId && message.role === "assistant" && Boolean(message.content));
      presentationTiming.applied(detail.session.id, turn.turnId, hasOutput, turn.phase === "settled");
    }
    markAvailability(result.session);
    schedulePersist();
    return withModel(result.session);
  }

  async function loadTask(guiId: string, taskId: string): Promise<void> {
    const key = `${guiId}:${taskId}`;
    if (sessionLoads.has(guiId) || taskLoads.has(key)) {
      dirtyTasks.set(key, { sessionId: guiId, taskId });
      return taskLoads.get(key);
    }
    if (!details.has(guiId)) return;
    const operation = (async () => {
      const messages = await client.request("task.messages", { taskId });
      scope(workspaceId);
      const current = transcripts.get(guiId) ?? new Map();
      current.set(taskId, mergeTaskMessages(current.get(taskId) ?? [], messages));
      transcripts.set(guiId, current);
      applyDetail(guiId);
    })().finally(() => {
      taskLoads.delete(key);
      if (dirtyTasks.delete(key) && watched.has(guiId) && !disposed) void loadTask(guiId, taskId).catch(reportError);
    });
    taskLoads.set(key, operation);
    return operation;
  }

  async function activate(input: AgentSessionActivateEffectInput, signal?: AbortSignal) {
    scope(input.workspaceId);
    if (input.mode === "existing") {
      const session = await loadSession(input.agentSessionId, signal);
      return { activation: { mode: "existing" as const, status: "already_attached" as const }, session,
        detail: { projection: "authoritative" as const, lifecycleCapabilitiesProjected: true, session, childSessions: [], turns: Object.values(engine.getSnapshot().sessionLifecycle.turnsById).filter((turn) => turn.agentSessionId === input.agentSessionId) } };
    }
    await modelHydration;
    await modelWrites.catch(() => {});
    const agent = assertInvoke(input.agentTargetId);
    if (input.initialGoalControl || input.initialTuttiModeActivation || input.isolation || input.cwd) unsupported("Goal, Tutti mode and local project activation");
    if (input.settings && Object.entries(input.settings).some(([key, value]) => key !== "model" && value != null && value !== false)) unsupported("Non-model conversation settings");
    let serverId = ledger.serverId(input.agentSessionId);
    if (serverId === input.agentSessionId) {
      if (ledger.creation(input.agentSessionId)) throw unconfirmed();
      ledger.beginCreation(input.agentSessionId);
      let resolveIdentity!: (id: string) => void;
      let rejectIdentity!: (error: unknown) => void;
      const identity = new Promise<string>((resolve, reject) => { resolveIdentity = resolve; rejectIdentity = reject; });
      void identity.catch(() => {});
      pendingIdentities.set(input.agentSessionId, { promise: identity, resolve: resolveIdentity, reject: rejectIdentity });
      try {
        await persist();
        const session = await client.request("session.create", { agentId: input.agentTargetId, title: input.title }, { signal });
        ledger.bind(input.agentSessionId, session.id);
        serverId = session.id;
        const model = selectedModel(agent.id) ?? (input.settings?.model && input.settings.model !== agent.model ? input.settings.model : null);
        modelPreferences.set(agent.id, session.id, model);
        await client.request("storage.write", { key: "model-preferences-v1", value: modelPreferences.serialize() });
        if (init.local) {
          await permissionHydration;
          await permissionWrites.catch(() => {});
          permissionPreferences.set(agent.id, session.id, selectedPermission(agent.id));
          await client.request("storage.write", { key: "permission-preferences-v1", value: permissionPreferences.serialize() });
        }
        await persist();
        replaceMetadata(session);
        resolveIdentity(session.id);
        void syncWatch().catch(reportError);
      } catch (error) {
        rejectIdentity(error);
        if (definitiveRejection(error)) ledger.discardCreation(input.agentSessionId);
        else ledger.failCreation(input.agentSessionId);
        await persist();
        throw error;
      } finally {
        pendingIdentities.delete(input.agentSessionId);
      }
    }
    if (input.initialContent?.length) {
      if (workspace.queueOwner === "desktop") await enqueueDesktop({ agentSessionId: input.agentSessionId, clientSubmitId: input.clientSubmitId, content: input.initialContent });
      else await send({ workspaceId, agentSessionId: input.agentSessionId, clientSubmitId: input.clientSubmitId, content: input.initialContent }, signal);
    }
    const session = await loadSession(input.agentSessionId, signal);
    return { activation: { mode: "new" as const, status: "attached" as const }, session };
  }

  async function enqueueDesktop(input: Parameters<typeof baseEngine.submitPrompt>[0], paused = false) {
    const sessionId = await backendSessionId(input.agentSessionId);
    const session = details.get(input.agentSessionId)?.session ?? workspace.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("Conversation is not loaded");
    if (input.targetTurnId || input.capabilityRefs?.length) unsupported("Active-turn guidance and capability references");
    const encoded = encodeContent([...(input.runtimeContent ?? input.content)]);
    const display = snapshotPromptQueues({ nextCommandSequence: 0, recordsBySessionId: {
      [input.agentSessionId]: { agentSessionId: input.agentSessionId, workspaceId, prompts: [{ ...input, id: input.clientSubmitId, createdAtUnixMs: Date.now() }],
        deliveryBarrierTurnId: null, failedPromptId: null, failureMessage: null, inFlight: null, sendNextPromptId: null, suspendReason: null, uncertainDelivery: null },
    } }, [...attachments.values()])[0]!.prompts[0]!;
    const timing = init.local ? createLocalTiming({ source: "gui", conversationId: sessionId, requestId: input.clientSubmitId }) : undefined;
    const enqueue = () => client.request("queue.enqueue", { sessionId, paused, queued: true, item: { ...encoded, requestId: input.clientSubmitId, display,
      ...(selectedModel(session.agent_id, input.agentSessionId) ? { model: selectedModel(session.agent_id, input.agentSessionId)! } : {}),
      permissionMode: selectedPermission(session.agent_id, input.agentSessionId),
    } });
    const result = await (timing ? timing.measure("gui.submit", enqueue) : enqueue());
    desktopQueue.receive(input.agentSessionId, result);
    return result;
  }

  async function send(input: AgentActivitySendInput, signal?: AbortSignal): Promise<unknown> {
    scope(input.workspaceId);
    await modelHydration;
    await modelWrites.catch(() => {});
    await permissionHydration;
    await permissionWrites.catch(() => {});
    scope(input.workspaceId);
    if (input.guidance || input.targetTurnId || input.capabilityRefs?.length) unsupported("Active-turn guidance and capability references");
    const detail = details.get(input.agentSessionId);
    const session = detail?.session ?? workspace.sessions.find((entry) => entry.id === ledger.serverId(input.agentSessionId));
    if (!session) throw new MulticaAgentGuiError("Conversation is not loaded.", "session_not_loaded");
    if (session.status === "archived") throw new MulticaAgentGuiError("This conversation is archived.", "session_archived");
    const pending = sendPromises.get(input.clientSubmitId);
    if (pending) return pending;
    const previous = ledger.submission(input.clientSubmitId);
    if (previous && previous.state !== "accepted") throw unconfirmed();
    const operation = (async () => {
      if (!previous?.response) {
        const encoded = encodeContent(input.content);
        const recipients = encoded.references?.filter((entry) => entry.kind === "agent") ?? [];
        if (recipients.length) recipients.forEach((entry) => {
          const target = workspace.agents.find((item) => item.agent.id === entry.id);
          if (!target?.canInvoke || !target.runtimeBound || target.agent.archived_at) throw new MulticaAgentGuiError("Mentioned agent is unavailable.", "agent_unavailable", 403);
        });
        else assertInvoke(session.agent_id, input.agentSessionId);
        ledger.setSubmission(input.clientSubmitId, { sessionId: session.id, state: "pending" });
        await persist();
        try {
          const timing = init.local ? createLocalTiming({ source: "gui", conversationId: session.id, requestId: input.clientSubmitId }) : undefined;
          const submit = () => client.request("session.send", {
            sessionId: session.id, ...encoded, requestId: input.clientSubmitId,
            ...(input.submitDiagnostics?.queued === true ? { queued: true as const } : {}),
            ...(!recipients.length && selectedModel(session.agent_id, input.agentSessionId) ? { model: selectedModel(session.agent_id, input.agentSessionId)! } : {}),
            ...(init.local && !recipients.length ? { permissionMode: selectedPermission(session.agent_id, input.agentSessionId) } : {}),
          }, { signal });
          const response = await (timing ? timing.measure("gui.submit", submit) : submit());
          ledger.setSubmission(input.clientSubmitId, { sessionId: session.id, state: "accepted", response });
          await persist();
        } catch (error) {
          if (definitiveRejection(error)) ledger.discardSubmission(input.clientSubmitId);
          else ledger.setSubmission(input.clientSubmitId, { sessionId: session.id, state: "unknown" });
          await persist();
          throw error;
        }
      }
      const projected = await loadFreshSession(input.agentSessionId, signal);
      const response = ledger.submission(input.clientSubmitId)!.response!;
      const turn = Object.values(engine.getSnapshot().sessionLifecycle.turnsById).find((item) => item.agentSessionId === input.agentSessionId && item.turnId === response.task_id);
      if (!turn) throw new MulticaAgentGuiError("The message was accepted; the run is still synchronizing. Refresh this conversation.", "accepted_pending_sync");
      return { kind: "turn", session: projected, turnId: response.task_id, turn };
    })().finally(() => { sendPromises.delete(input.clientSubmitId); });
    sendPromises.set(input.clientSubmitId, operation);
    return operation;
  }

  function encodeContent(blocks: AgentActivitySendInput["content"]) {
    const text: string[] = [];
    const attachmentIds: string[] = [];
    const references = new Map<string, AgentGuiContextReference>();
    for (const block of blocks) {
      if (block.type === "text") {
        if (block.text) {
          text.push(block.text);
          for (const mention of extractRichTextMentionsFromContent(block.text)) {
            const kind = mention.providerId === "workspace-issue" ? "issue" : mention.providerId === "agent-session" ? "session" : mention.providerId === "agent-target" ? "agent" : null;
            if (kind) {
              if (mention.scope?.workspaceId !== workspaceId) throw new MulticaAgentGuiError("The reference belongs to another workspace.", "invalid_reference", 403);
              references.set(`${kind}:${mention.entityId}`, { kind, id: mention.entityId });
            }
            if (mention.providerId !== "file") continue;
            const attachment = [...attachments.values()].find((entry) =>
              [entry.url, entry.markdown_url, entry.download_url, entry.attachment_download_url].some((url) => Boolean(url) && url === mention.entityId),
            );
            if (attachment) attachmentIds.push(attachment.id);
          }
          // Ordinary files use source-generated Markdown links, while image
          // and staged-file blocks can carry explicit asset identities.
          for (const attachment of attachments.values()) {
            if (contentReferencesAttachment(block.text, attachment)) attachmentIds.push(attachment.id);
          }
        }
        continue;
      }
      if (block.type !== "file" && block.type !== "image") unsupported(`${block.type} prompt content`);
      const id = block.attachmentId || block.assetId;
      if (!id) unsupported("Files that have not been uploaded to Multica");
      attachmentIds.push(id);
      const attachment = attachments.get(id);
      if (init.local && block.type === "image") {
        text.push(`[Image attachment: ${block.name || attachment?.filename || "Image"}]`);
        continue;
      }
      const url = attachment?.markdown_url || block.url;
      if (url) text.push(`${block.type === "image" ? "!" : ""}[${block.name || attachment?.filename || "Attachment"}](${url})`);
    }
    if (!text.length && !attachmentIds.length) throw new MulticaAgentGuiError("Enter a message before sending.", "empty_message");
    return { content: text.join("\n\n"), ...(attachmentIds.length ? { attachmentIds: [...new Set(attachmentIds)] } : {}),
      ...(references.size ? { references: [...references.values()] } : {}) };
  }

  async function executeExtension(command: EngineExtensionCommand, options?: { signal?: AbortSignal }): Promise<unknown> {
    switch (command.type) {
      case "session/forkThroughTurn": {
        scope(command.workspaceId);
        const session = await client.request("session.fork", { sessionId: await backendSessionId(command.sourceAgentSessionId), turnId: command.turnId, requestId: command.requestId }, { signal: options?.signal });
        scope(command.workspaceId);
        ledger.bind(command.targetAgentSessionId, session.id);
        await persist(); replaceMetadata(session);
        const result = await loadFreshSession(command.targetAgentSessionId, options?.signal);
        return { operationId: session.id, requestId: command.requestId, sourceAgentSessionId: command.sourceAgentSessionId, targetAgentSessionId: command.targetAgentSessionId, turnId: command.turnId, status: "committed", session: result, error: null };
      }
      case "session/ackForkObserved": return undefined;
      case "engine/reconcileWorkspace": return loadWorkspace();
      case "session/reconcile": await loadSession(command.agentSessionId, options?.signal); return { status: "applied" };
      case "composerOptions/load": {
        const agent = descriptor(command.targetKey);
        const options = composerOptions(agent);
        const model = selectedModel(agent.id, command.agentSessionId) ?? agent.model ?? null;
        return { ...options, effectiveModel: model, effectiveSettings: { ...options.effectiveSettings, model } };
      }
      case "session/unactivate": return undefined;
      case "attention/readState/read": return attention;
      case "attention/readState/write": {
        const previousUnread = [...attention.completed.unreadIds, ...attention.failed.unreadIds];
        attention = {
          completed: { readIds: [...command.completed.readIds], unreadIds: [...command.completed.unreadIds] },
          failed: { readIds: [...command.failed.readIds], unreadIds: [...command.failed.unreadIds] },
        };
        await client.request("storage.write", { key: "attention-read-state-v1", value: JSON.stringify(attention) });
        const nextUnread = new Set([...attention.completed.unreadIds, ...attention.failed.unreadIds]);
        const read = new Set([...command.completed.readIds, ...command.failed.readIds, ...previousUnread.filter((id) => !nextUnread.has(id))]);
        const sessionsToMark = new Set<string>();
        for (const completionId of read) {
          const guiId = /^turn:([^:]+):[^:]+:(completed|failed)$/.exec(completionId)?.[1];
          if (guiId) sessionsToMark.add(ledger.serverId(guiId));
        }
        await Promise.all([...sessionsToMark].map((sessionId) => client.request("session.markRead", { sessionId })));
        return undefined;
      }
      default: return unsupported(command.type);
    }
  }

  function registerAttachments(values: Attachment[]) {
    for (const attachment of values) attachments.set(attachment.id, attachment);
  }

  const runtime: AgentGUIRuntime = {
    origin: "multica", projectPathIsRemote: !init.local, conversationActivityViewEnabled: true,
    promptContentUploadSupport: { file: true, image: true }, devDiagnosticConsoleSink: false,
    getSessionEngine: (id) => { scope(id); return engine; },
    getSnapshot: (id) => { scope(id); return projectSnapshot(engine.getSnapshot()); },
    subscribe: (id, listener) => { scope(id); return engine.subscribe((state) => listener(projectSnapshot(state))); },
    subscribeSessionEvents: (id, listener) => { scope(id); eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
    load: (id) => { scope(id); return loadWorkspace(); },
    getSession: (id, sessionId) => { scope(id); return loadSession(sessionId); },
    getComposerOptions: async (input): Promise<AgentActivityComposerOptions> => {
      scope(input.workspaceId);
      return engine.loadComposerOptions({
        targetKey: input.agentTargetId,
        provider: input.provider ?? descriptor(input.agentTargetId).provider,
        agentSessionId: input.agentSessionId,
        cwd: input.cwd,
        force: input.force,
        waitForFreshModelCatalog: input.waitForFreshModelCatalog,
        settings: input.settings,
        section: input.section === "full" ? undefined : input.section,
      });
    },
    listSessionMessages: async (input) => {
      scope(input.workspaceId);
      await loadSession(input.agentSessionId, input.signal);
      let messages = (projectSnapshot(engine.getSnapshot()).sessionMessagesById[input.agentSessionId] ?? []) as AgentActivityDurableMessage[];
      if (input.afterVersion !== undefined) messages = messages.filter((message) => message.version > input.afterVersion!);
      if (input.beforeVersion !== undefined) messages = messages.filter((message) => message.version < input.beforeVersion!);
      if (input.order === "desc") messages = [...messages].reverse();
      const limit = input.limit ?? messages.length;
      return { messages: messages.slice(0, limit), hasMore: messages.length > limit, latestVersion: ledger.latestVersion(input.agentSessionId) };
    },
    ensureSessionSynchronized: (input) => {
      scope(input.workspaceId);
      watched.set(input.agentSessionId, (watched.get(input.agentSessionId) ?? 0) + 1);
      void syncWatch().then(() => loadSession(input.agentSessionId)).catch(input.onError ?? reportError);
      return () => {
        const count = (watched.get(input.agentSessionId) ?? 1) - 1;
        if (count > 0) watched.set(input.agentSessionId, count); else watched.delete(input.agentSessionId);
        if (!disposed) void syncWatch().catch(reportError);
      };
    },
    renameSession: (input) => engine.renameSession(input),
    setSessionPinned: (input) => engine.setSessionPinned(input),
    deleteSession: async () => unsupported("Recoverable session deletion"),
    uploadPromptContent: async (input) => {
      scope(input.workspaceId);
      const content = await Promise.all(input.content.map(async (block) => {
        if (block.type !== "file" && block.type !== "image") return block;
        if (block.attachmentId || block.assetId) return block;
        let blob: Blob;
        if (block.data) {
          const data = atob(block.data.includes(",") ? block.data.split(",").slice(1).join(",") : block.data);
          blob = new Blob([Uint8Array.from(data, (character) => character.charCodeAt(0))], { type: block.mimeType || "application/octet-stream" });
        } else if (block.url?.startsWith("blob:")) {
          blob = await fetch(block.url).then((response) => response.blob());
        } else return unsupported("Unprepared local file paths");
        const file = new File([blob], block.name || "attachment", { type: block.mimeType || blob.type });
        const attachment = await client.request("attachment.upload", { file });
        registerAttachments([attachment]);
        return { ...block, data: undefined, attachmentId: attachment.id, assetId: attachment.id,
          name: attachment.filename, mimeType: attachment.content_type, sizeBytes: attachment.size_bytes,
          url: init.local && block.type === "image" ? undefined : attachment.markdown_url || attachment.url, uploadStatus: "uploaded" };
      }));
      return { content };
    },
    stagePastedText: async (input) => {
      scope(input.workspaceId);
      const attachment = await client.request("attachment.upload", { file: new File([input.text], input.name, { type: "text/plain" }) });
      registerAttachments([attachment]);
      return { name: attachment.filename, url: attachment.markdown_url || attachment.url, assetId: attachment.id,
        mimeType: attachment.content_type, sizeBytes: attachment.size_bytes, uploadStatus: "uploaded" };
    },
    readSessionAttachment: async (input) => {
      scope(input.workspaceId);
      return { attachmentId: input.attachmentId, ...await client.request("attachment.read", { attachmentId: input.attachmentId }) };
    },
    readPromptAsset: async (input) => {
      scope(input.workspaceId);
      if (!input.assetId) unsupported("Unprepared prompt assets");
      const value = await client.request("attachment.read", { attachmentId: input.assetId });
      return { ...value, assetId: input.assetId, path: input.path || input.uri || `multica-attachment:${input.assetId}` };
    },
  };

  const unsubscribe = client.subscribe((event) => {
    if (disposed || !initialized) return;
    if (event.type === "connection") {
      engine.dispatch({ type: "engine/connectionChanged", status: event.connected ? "connected" : "disconnected", workspaceId });
      return;
    }
    if (event.type !== "invalidate") return;
    if (event.generation !== undefined && event.generation < latestGeneration) return;
    latestGeneration = Math.max(latestGeneration, event.generation ?? 0);
    if (event.scope === "workspace") {
      if (workspaceLoad) workspaceDirty = true;
      else void loadWorkspace().catch(reportError);
    }
    else {
      const id = ledger.guiId(event.sessionId);
      if (watched.has(id)) {
        if (event.scope === "task") void loadTask(id, event.taskId).catch(reportError);
        else if (sessionLoads.has(id)) dirtySessions.add(id);
        else void loadSession(id).catch(reportError);
      }
    }
  });

  return {
    runtime,
    async moveQueuedToSide(agentSessionId: string, promptId: string) {
      const queue = engine.getSnapshot().promptQueue.recordsBySessionId[agentSessionId];
      const prompt = queue?.prompts.find((item) => item.id === promptId);
      if (!queue || !prompt || queue.inFlight?.promptId === promptId || queue.uncertainDelivery?.promptId === promptId) throw new Error("This queued message has already started");
      if (workspace.queueOwner === "desktop") {
        const sessionId = await backendSessionId(agentSessionId);
        const side = await client.request("host.openSide", { sessionId, requestId: `side:${sessionId}:${prompt.clientSubmitId || prompt.id}`, queued: true, queuedRequestId: prompt.clientSubmitId || prompt.id });
        await loadFreshSession(agentSessionId);
        return side;
      }
      const wasPaused = queue.suspendReason !== null;
      engine.dispatch({ type: "queue/suspended", agentSessionId, reason: "user_stop" });
      await persist();
      const sessionId = await backendSessionId(agentSessionId);
      const requestId = `side:${sessionId}:${prompt.clientSubmitId || prompt.id}`;
      const encoded = encodeContent([...(prompt.runtimeContent ?? prompt.content)]);
      const session = details.get(agentSessionId)?.session;
      const model = session ? selectedModel(session.agent_id, agentSessionId) : null;
      // The durable desktop receipt owns this prompt before queue removal.
      const side = await client.request("host.openSide", { sessionId, requestId, queued: true, pending: { ...encoded, ...(model ? { model } : {}), ...(init.local && session ? { permissionMode: selectedPermission(session.agent_id, agentSessionId) } : {}), requestId } });
      engine.dispatch({ type: "queue/removed", agentSessionId, promptId });
      await persist();
      if (!wasPaused) engine.dispatch({ type: "queue/resumed", agentSessionId });
      await client.request("host.startSide", { sessionId: side.id, queued: true });
      return side;
    },
    async initialize() {
      if (initialized) return;
      ledger.hydrate(await client.request("storage.read", { key: STORAGE_KEY }));
      await modelHydration;
      await permissionHydration;
      const readState = await client.request("storage.read", { key: "attention-read-state-v1" });
      if (readState) {
        const value = JSON.parse(readState);
        if (value && typeof value === "object" && [value.completed, value.failed].every((entry) => entry && Array.isArray(entry.readIds) && Array.isArray(entry.unreadIds) && [...entry.readIds, ...entry.unreadIds].every((id) => typeof id === "string"))) attention = value;
      }
      initialized = true;
      await loadWorkspace();
      const active = init.local && init.activeSessionId ? workspace.sessions.find((session) => session.id === init.activeSessionId) : undefined;
      if (active && permissionPreferences.get(active.agent_id) === undefined) {
        const saved = permissionPreferences.get(active.agent_id, active.id);
        // Retain an explicit choice made before provider defaults were remembered.
        if (saved !== undefined) await setPermissionSelection(active.agent_id, null, saved).catch(reportError);
      }
      await restorePromptQueues();
      engine.dispatch({ type: "engine/connectionChanged", status: "connected", workspaceId });
    },
    getWorkspaceState: () => workspace,
    getModelSelection: selectedModel,
    setModelSelection,
    getPermissionSelection: selectedPermission,
    setPermissionSelection,
    getPermissionRevision: () => permissionRevision,
    subscribePermissions: (listener: () => void) => { permissionListeners.add(listener); return () => { permissionListeners.delete(listener); }; },
    isModelSelectionBusy,
    getModelRevision: () => modelRevision,
    subscribeModels: (listener: () => void) => { modelListeners.add(listener); return () => { modelListeners.delete(listener); }; },
    subscribeWorkspace: (listener: () => void) => { workspaceListeners.add(listener); return () => { workspaceListeners.delete(listener); }; },
    toServerSessionId: resolvedServerId,
    toGuiSessionId: (id: string) => ledger.guiId(id),
    registerAttachments,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      unsubscribeQueues();
      for (const pending of pendingIdentities.values()) pending.reject(new MulticaAgentGuiError("This connection has closed.", "disposed"));
      pendingIdentities.clear();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; void persist().catch(() => {}); }
      void client.request("session.watch", { sessionIds: [] }).catch(() => {});
      engine.dispose();
      workspaceListeners.clear();
      modelListeners.clear();
      eventListeners.clear();
    },
  };
}

function unconfirmed() {
  return new MulticaAgentGuiError("The previous request was not confirmed. Refresh the conversation before submitting a new request.", "submission_unconfirmed");
}

function definitiveRejection(error: unknown): boolean {
  const status = error && typeof error === "object" && "status" in error ? error.status : null;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}

async function parallelMap<T>(values: T[], run: (value: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (next < values.length) await run(values[next++]!);
  }));
}

function mergeTaskMessages(previous: AgentGuiTaskMessagePayload[], incoming: AgentGuiTaskMessagePayload[]) {
  return [...new Map([...previous, ...incoming].map((message) => [message.seq, message])).values()]
    .sort((a, b) => a.seq - b.seq);
}
