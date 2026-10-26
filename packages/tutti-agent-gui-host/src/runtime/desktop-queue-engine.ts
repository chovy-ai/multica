import type { AgentSessionEngine, EngineQueuedPrompt, PromptQueueRecord } from "@tutti-os/agent-activity-core";
import type { LocalPromptQueue } from "../local-protocol";
type SubmitInput = Parameters<AgentSessionEngine["submitPrompt"]>[0];

/** Presentation adapter only: Electron owns admission, persistence and draining. */
export function createDesktopQueueEngine(base: AgentSessionEngine, options: {
  enabled(): boolean;
  enqueue(input: SubmitInput): Promise<LocalPromptQueue>;
  update(id: string, action: "pause" | "stop" | "resume" | "remove" | "sendNow", requestId?: string): Promise<LocalPromptQueue>;
  error(error: unknown): void;
}) {
  const queues = new Map<string, LocalPromptQueue>();
  const pending = new Map<string, EngineQueuedPrompt[]>();
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
    for (const id of new Set([...queues.keys(), ...pending.keys()])) {
      const queue = queues.get(id);
      const items = queue?.items.map((item) => item.display) ?? [];
      const prompts = [...items, ...(pending.get(id) ?? []).filter((item) => !items.some((existing) => existing.clientSubmitId === item.clientSubmitId))];
      records[id] = { agentSessionId: id, workspaceId: base.identity.workspaceId, prompts,
        deliveryBarrierTurnId: null, failedPromptId: queue?.error ? prompts[0]?.id ?? null : null,
        failureMessage: queue?.error ?? null, inFlight: null, sendNextPromptId: null,
        suspendReason: queue?.paused ? "user_stop" : null, uncertainDelivery: null,
      } satisfies PromptQueueRecord;
    }
    lastBase = state; lastRevision = revision;
    return cached = { ...state, promptQueue: { ...state.promptQueue, recordsBySessionId: records } };
  };
  const publish = () => { revision++; for (const listener of listeners) listener(snapshot()); };
  const receive = (id: string, queue?: LocalPromptQueue) => {
    if (queue && (!queues.has(id) || queue.revision >= queues.get(id)!.revision)) { queues.set(id, queue); publish(); }
  };
  const update = (id: string, action: "pause" | "resume" | "remove" | "sendNow", promptId?: string) => {
    const prompt = snapshot().promptQueue.recordsBySessionId[id]?.prompts.find((item) => item.id === promptId);
    void options.update(id, action, prompt?.clientSubmitId || promptId).then((queue) => receive(id, queue)).catch(options.error);
  };
  const unsubscribe = base.subscribe(() => { for (const listener of listeners) listener(snapshot()); });
  const engine: AgentSessionEngine = { ...base,
    getSnapshot: snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    submitPrompt(input) {
      if (!options.enabled()) return base.submitPrompt(input);
      if (!input.content.length || !input.clientSubmitId) return { accepted: false, queued: false };
      const id = input.agentSessionId;
      const display: EngineQueuedPrompt = { ...input, id: input.clientSubmitId, createdAtUnixMs: Date.now(), visibleInQueue: true };
      pending.set(id, [...(pending.get(id) ?? []), display]); publish();
      void options.enqueue(input).then((queue) => {
        pending.set(id, (pending.get(id) ?? []).filter((item) => item.id !== display.id)); receive(id, queue); publish();
      }).catch((error) => {
        // Keep an unconfirmed admission visible; never clear the user's text.
        const current = queues.get(id) ?? { revision: 0, paused: true, items: [] };
        queues.set(id, { ...current, paused: true, error: error instanceof Error ? error.message : String(error) }); publish(); options.error(error);
      });
      return { accepted: true, queued: true };
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
      void options.update(input.agentSessionId, "stop").then((queue) => { receive(input.agentSessionId, queue); }).catch(options.error);
    },
    dispose() { unsubscribe(); listeners.clear(); base.dispose(); },
  };
  return { engine, receive };
}
