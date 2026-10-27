import type { AgentSessionEngine, EngineQueuedPrompt, PromptQueueRecord } from "@tutti-os/agent-activity-core";
import { selectEngineSubmitWouldBeVisibleInQueue } from "@tutti-os/agent-activity-core";
import type { LocalPromptQueue } from "@multica/core/local-conversation/protocol";
type SubmitInput = Parameters<AgentSessionEngine["submitPrompt"]>[0];
interface PendingPrompt {
  input: SubmitInput;
  display: EngineQueuedPrompt;
  admission?: Promise<LocalPromptQueue>;
  confirmed?: boolean;
}

/** Presentation adapter only: Electron owns admission, persistence and draining. */
export function createDesktopQueueEngine(base: AgentSessionEngine, options: {
  enabled(): boolean;
  enqueue(input: SubmitInput): Promise<LocalPromptQueue>;
  update(id: string, action: "pause" | "stop" | "resume" | "remove" | "sendNow", requestId?: string): Promise<LocalPromptQueue>;
  error(error: unknown): void;
}) {
  const queues = new Map<string, LocalPromptQueue>();
  const pending = new Map<string, PendingPrompt[]>();
  const errors = new Map<string, { message: string; promptId?: string; origin: "admission" | "operation" }>();
  const operations = new Map<string, Promise<void>>();
  const listeners = new Set<Parameters<AgentSessionEngine["subscribe"]>[0]>();
  let revision = 0;
  let cached: ReturnType<AgentSessionEngine["getSnapshot"]> | undefined;
  let lastBase: typeof cached;
  let lastRevision = -1;
  const snapshot = () => {
    const state = base.getSnapshot();
    if (!options.enabled()) return state;
    if (cached && state === lastBase && revision === lastRevision) return cached;
    const records = { ...state.promptQueue.recordsBySessionId };
    const submits = { ...state.pendingIntents.submitsByClientSubmitId };
    for (const id of new Set([...queues.keys(), ...pending.keys(), ...errors.keys()])) {
      const queue = queues.get(id);
      const dispatching = queue?.paused || queue?.error ? undefined : queue?.dispatchingRequestId;
      const items: EngineQueuedPrompt[] = queue?.items.map((item) => item.requestId === dispatching ? { ...item.display, visibleInQueue: false } : item.display) ?? [];
      const prompts = [...items, ...(pending.get(id) ?? []).map((item) => item.display).filter((item) => !items.some((existing) => existing.clientSubmitId === item.clientSubmitId))];
      const error = errors.get(id);
      const failureMessage = error?.message ?? queue?.error ?? null;
      for (const prompt of prompts) if (prompt.visibleInQueue === false) {
        const clientSubmitId = prompt.clientSubmitId || prompt.id;
        submits[clientSubmitId] = { agentSessionId: id, clientSubmitId, workspaceId: base.identity.workspaceId,
          content: prompt.content, status: "requested", requestedAtUnixMs: prompt.createdAtUnixMs, expiresAtUnixMs: Number.MAX_SAFE_INTEGER,
          acceptedSessionVersion: null, errorCode: null, errorMessage: null, errorReason: null, turnId: null };
      }
      records[id] = { agentSessionId: id, workspaceId: base.identity.workspaceId, prompts,
        deliveryBarrierTurnId: null, failedPromptId: failureMessage ? error?.promptId ?? prompts[0]?.id ?? null : null,
        failureMessage, inFlight: null, sendNextPromptId: null,
        suspendReason: queue?.paused || error ? "user_stop" : null, uncertainDelivery: null,
      } satisfies PromptQueueRecord;
    }
    lastBase = state; lastRevision = revision;
    return cached = { ...state, promptQueue: { ...state.promptQueue, recordsBySessionId: records }, pendingIntents: { ...state.pendingIntents, submitsByClientSubmitId: submits } };
  };
  const publish = () => { revision++; for (const listener of listeners) listener(snapshot()); };
  const clearError = (id: string, promptId: string | undefined, origin: "admission" | "operation") => {
    const error = errors.get(id);
    if (error && error.promptId === promptId && error.origin === origin) errors.delete(id);
  };
  const fail = (id: string, error: unknown, promptId?: string, origin: "admission" | "operation" = "operation") => {
    errors.set(id, { message: error instanceof Error ? error.message : String(error), promptId, origin });
    publish(); options.error(error);
  };
  const receive = (id: string, queue?: LocalPromptQueue) => {
    if (!queue || queues.has(id) && queue.revision < queues.get(id)!.revision) return;
    queues.set(id, queue);
    pending.set(id, (pending.get(id) ?? []).filter((item) => {
      if (!queue.items.some((prompt) => prompt.requestId === item.input.clientSubmitId)) return true;
      item.confirmed = true;
      clearError(id, item.display.id, "admission");
      return false;
    }));
    publish();
  };
  const admit = (id: string, item: PendingPrompt): Promise<LocalPromptQueue> => {
    if (item.admission) return item.admission;
    item.admission = options.enqueue(item.input).then((queue) => {
      item.confirmed = true;
      pending.set(id, (pending.get(id) ?? []).filter((value) => value !== item));
      clearError(id, item.display.id, "admission");
      receive(id, queue); publish();
      return queues.get(id)!;
    }, (error: unknown) => {
      // A canonical queue snapshot can confirm admission before its RPC reply.
      if (item.confirmed) return queues.get(id)!;
      item.display = { ...item.display, visibleInQueue: true };
      fail(id, error, item.display.id, "admission");
      throw error;
    }).finally(() => { delete item.admission; });
    return item.admission;
  };
  const update = (id: string, action: "pause" | "stop" | "resume" | "remove" | "sendNow", promptId?: string) => {
    const prompt = snapshot().promptQueue.recordsBySessionId[id]?.prompts.find((item) => item.id === promptId);
    const requestId = prompt?.clientSubmitId || promptId;
    const key = JSON.stringify([id, action, requestId]);
    if (operations.has(key)) return;
    const operation = (async () => {
      const item = (pending.get(id) ?? []).find((value) => value.input.clientSubmitId === requestId);
      if (action === "sendNow" && item) {
        try { await admit(id, item); } catch { return; }
      }
      // Re-admission uses the original ID. A missing or dispatching item was
      // already accepted for execution; never interrupt it or send it again.
      const current = queues.get(id);
      if (action === "sendNow" && current && (!current.items.some((value) => value.requestId === requestId) || current.dispatchingRequestId === requestId)) return;
      try {
        const queue = await options.update(id, action, requestId);
        clearError(id, promptId, "operation");
        receive(id, queue); publish();
      } catch (error) { fail(id, error, promptId); }
    })();
    operations.set(key, operation);
    void operation.finally(() => operations.delete(key));
  };
  const unsubscribe = base.subscribe(() => { for (const listener of listeners) listener(snapshot()); });
  const engine: AgentSessionEngine = { ...base,
    getSnapshot: snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    submitPrompt(input) {
      if (!options.enabled()) return base.submitPrompt(input);
      if (!input.content.length || !input.clientSubmitId) return { accepted: false, queued: false };
      const id = input.agentSessionId;
      const queued = selectEngineSubmitWouldBeVisibleInQueue(snapshot(), id);
      const saved = structuredClone(input);
      const item: PendingPrompt = { input: saved, display: { ...saved, id: saved.clientSubmitId, createdAtUnixMs: Date.now(), visibleInQueue: queued } };
      pending.set(id, [...(pending.get(id) ?? []), item]); publish();
      void admit(id, item).catch(() => {});
      return { accepted: true, queued };
    },
    dispatch(intent, dispatchOptions) {
      if (options.enabled() && "agentSessionId" in intent && typeof intent.agentSessionId === "string") {
        const id = intent.agentSessionId;
        if (intent.type === "queue/suspended") { update(id, "pause"); return; }
        if (intent.type === "queue/resumed") { update(id, "resume"); return; }
        if (intent.type === "queue/removed") { update(id, "remove", intent.promptId); return; }
        if (intent.type === "submit/canceled") { update(id, "remove", intent.clientSubmitId); return; }
        if (intent.type === "queue/sendNowRequested") { update(id, "sendNow", intent.promptId); return; }
      }
      base.dispatch(intent, dispatchOptions);
    },
    stopSession(input) {
      if (!options.enabled()) return base.stopSession(input);
      // Persist the pause before the cancellation can release the next turn.
      update(input.agentSessionId, "stop");
    },
    dispose() { unsubscribe(); listeners.clear(); base.dispose(); },
  };
  return { engine, receive };
}
