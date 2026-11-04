import { action, makeObservable, observable } from "mobx";
import type { LocalPromptQueue } from "@multica/core/local-conversation/protocol";
import "../mobx-config";

export type PromptQueueAction = "pause" | "stop" | "resume" | "remove" | "sendNow";

export interface PromptInput { agentSessionId: string; clientSubmitId: string }
export interface PromptDisplay { id: string; clientSubmitId?: string; visibleInQueue?: boolean }

interface PendingPrompt<Input, Display> {
  input: Input;
  display: Display;
  admission?: Promise<LocalPromptQueue>;
  confirmed?: boolean;
  restored?: boolean;
}

export interface PromptError { message: string; promptId?: string; origin: "admission" | "operation" }
export interface SavedPrompts<Display> { agentSessionId: string; prompts: Display[] }
/** What the daemon says became of a message; see the queue status route. */
export type PromptStatus = "queued" | "dispatching" | "delivered" | "failed" | "unknown" | "removed" | "none";

export interface PromptServiceOptions<Input extends PromptInput, Display extends PromptDisplay> {
  enqueue(input: Input): Promise<LocalPromptQueue>;
  update(id: string, action: PromptQueueAction, requestId?: string): Promise<LocalPromptQueue>;
  error(error: unknown): void;
  /** Messages a previous document had not handed to the daemon. */
  restored?: { agentSessionId: string; input: Input; display: Display }[];
  /** Keeps what has not been handed over; runs before anyone is told of a change. */
  save?(queues: { agentSessionId: string; items: { input: Input; display: Display }[] }[]): void;
  /** Reports each message's fate; absent on a daemon that cannot. */
  statuses?(id: string, requestIds: string[]): Promise<Record<string, PromptStatus>>;
}

/**
 * Sending and the queue, as far as this client knows: what is on its way to the
 * daemon, what the daemon has queued, and what failed. The daemon owns admission,
 * persistence and draining, and keeps running with no window open; this only keeps
 * the user's view immediate and honest in between.
 */
export class PromptService<Input extends PromptInput, Display extends PromptDisplay> {
  private readonly queues = new Map<string, LocalPromptQueue>();
  private readonly pendingBySession = new Map<string, PendingPrompt<Input, Display>[]>();
  private readonly errors = new Map<string, PromptError>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly steering = new Map<string, { sessionId: string; requestId?: string; promptId: string; accepted: boolean }>();
  private readonly reconciled = new Set<string>();
  private disposed = false;
  /** Changes with everything here, for whoever presents it. */
  revision = 0;

  constructor(private readonly options: PromptServiceOptions<Input, Display>) {
    for (const item of options.restored ?? []) {
      const list = this.pendingBySession.get(item.agentSessionId) ?? [];
      list.push({ input: item.input, display: item.display, restored: true });
      this.pendingBySession.set(item.agentSessionId, list);
    }
    makeObservable(this, { revision: observable, bump: action });
  }

  bump(): void { this.revision++; }

  sessionIds(): string[] { return [...new Set([...this.queues.keys(), ...this.pendingBySession.keys(), ...this.errors.keys()])]; }
  queue(id: string): LocalPromptQueue | undefined { return this.queues.get(id); }
  pending(id: string): readonly PendingPrompt<Input, Display>[] { return this.pendingBySession.get(id) ?? []; }
  error(id: string): PromptError | undefined { return this.errors.get(id); }
  /** The message being sent ahead of the queue, and the operation doing it. */
  sending(id: string): { key: string; promptId: string } | undefined {
    for (const [key, value] of this.steering) if (value.sessionId === id) return { key, promptId: value.promptId };
    return undefined;
  }
  hasPrompt(id: string, requestId: string | undefined): boolean {
    return this.pending(id).some((item) => item.input.clientSubmitId === requestId)
      || !!this.queues.get(id)?.items.some((item) => item.requestId === requestId);
  }

  /** Everything queued for the session, each message once: one the daemon has is not also pending. */
  prompts(id: string): Display[] {
    const queue = this.queues.get(id);
    const dispatching = queue?.paused || queue?.error ? undefined : queue?.dispatchingRequestId;
    const items = (queue?.items.map((item) => item.requestId === dispatching ? { ...item.display, visibleInQueue: false } : item.display) ?? []) as unknown as Display[];
    return [...items, ...this.pending(id).map((item) => item.display).filter((item) => !items.some((existing) => existing.clientSubmitId === item.clientSubmitId))];
  }

  private publish() {
    if (this.disposed) return;
    // Checkpoint before anyone may clear the composer: even a message on its way
    // must survive this document being destroyed.
    this.options.save?.([...this.pendingBySession].flatMap(([agentSessionId, items]) => items.length
      ? [{ agentSessionId, items: items.map((item) => ({ input: item.input, display: item.display })) }] : []));
    this.bump();
  }

  private clearError(id: string, promptId: string | undefined, origin: PromptError["origin"]) {
    const error = this.errors.get(id);
    if (error && error.promptId === promptId && error.origin === origin) this.errors.delete(id);
  }

  private fail(id: string, error: unknown, promptId?: string, origin: PromptError["origin"] = "operation") {
    this.errors.set(id, { message: error instanceof Error ? error.message : String(error), promptId, origin });
    this.publish();
    this.options.error(error);
  }

  /** The queue as the daemon reports it. An acknowledgement can arrive after a newer snapshot, so revisions only rise. */
  receive(id: string, incoming?: LocalPromptQueue): void {
    if (this.disposed || !incoming) return;
    const known = this.queues.get(id);
    const queue = known && incoming.revision < known.revision ? known : incoming;
    this.queues.set(id, queue);
    for (const [key, request] of this.steering) if (request.sessionId === id && (
      !queue.items.some((item) => item.requestId === request.requestId) && !this.pending(id).some((item) => item.input.clientSubmitId === request.requestId && !item.confirmed)
      || queue.dispatchingRequestId === request.requestId
      || request.accepted && (queue.paused || queue.error)
    )) this.steering.delete(key);
    this.pendingBySession.set(id, this.pending(id).filter((item) => {
      if (!queue.items.some((prompt) => prompt.requestId === item.input.clientSubmitId)) return true;
      item.confirmed = true;
      this.clearError(id, item.display.id, "admission");
      return false;
    }));
    this.publish();
    this.reconcileRestored(id);
  }

  /**
   * Restored messages may have gone out before the reload, possibly in a turn
   * not loaded here, so ask. One that may have been delivered stays, for the user
   * to judge; sending it again is not this client's call.
   */
  private reconcileRestored(id: string) {
    if (!this.options.statuses || this.reconciled.has(id)) return;
    const restored = this.pending(id).filter((item) => item.restored && !item.admission);
    if (!restored.length) return;
    this.reconciled.add(id);
    void this.options.statuses(id, restored.map((item) => item.input.clientSubmitId)).then((statuses) => {
      if (this.disposed) return;
      const settled = new Set<PromptStatus>(["queued", "dispatching", "delivered", "removed"]);
      const before = this.pending(id).length;
      this.pendingBySession.set(id, this.pending(id).filter((item) => !item.restored || !settled.has(statuses[item.input.clientSubmitId] ?? "none")));
      if (this.pending(id).length !== before) this.publish();
    }).catch(() => { /* A daemon that cannot answer leaves them for the user, as before. */ });
  }

  /** Takes a message on its way: shown at once, with its failure and retry here. */
  submit(input: Input, display: Display): void {
    const item: PendingPrompt<Input, Display> = { input, display };
    this.pendingBySession.set(input.agentSessionId, [...this.pending(input.agentSessionId), item]);
    this.publish();
    void this.admit(input.agentSessionId, item).catch(() => {});
  }

  private admit(id: string, item: PendingPrompt<Input, Display>): Promise<LocalPromptQueue> {
    if (item.admission) return item.admission;
    item.admission = this.options.enqueue(item.input).then((queue) => {
      if (this.disposed) return queue;
      item.confirmed = true;
      this.pendingBySession.set(id, this.pending(id).filter((value) => value !== item));
      this.clearError(id, item.display.id, "admission");
      this.receive(id, queue);
      this.publish();
      return this.queues.get(id)!;
    }, (error: unknown) => {
      if (this.disposed) throw error;
      // A canonical queue snapshot can confirm admission before its reply.
      if (item.confirmed) return this.queues.get(id)!;
      item.display = { ...item.display, visibleInQueue: true };
      this.fail(id, error, item.display.id, "admission");
      throw error;
    }).finally(() => { delete item.admission; });
    return item.admission;
  }

  update(id: string, queueAction: PromptQueueAction, promptId?: string): void {
    const prompt = this.prompts(id).find((item) => item.id === promptId);
    const requestId = prompt?.clientSubmitId || promptId;
    const key = JSON.stringify([id, queueAction, requestId]);
    if (this.operations.has(key) || this.steering.has(key)) return;
    const request = queueAction === "sendNow" && promptId ? { sessionId: id, requestId, promptId, accepted: false } : undefined;
    if (request) { this.steering.set(key, request); this.publish(); }
    const operation = (async () => {
      const item = this.pending(id).find((value) => value.input.clientSubmitId === requestId);
      if (queueAction === "sendNow" && item) {
        try { await this.admit(id, item); } catch { return; }
      }
      if (queueAction === "remove" && item?.admission) {
        // Wait for the original admission before removing its canonical item.
        // A rejected admission can still be discarded explicitly.
        try { await item.admission; } catch { /* Removal also handles rejection. */ }
      }
      if (this.disposed) return;
      // Re-admission uses the original id. A missing or dispatching item was
      // already accepted for execution; never interrupt it or send it again.
      const current = this.queues.get(id);
      if (queueAction === "sendNow" && current && (!current.items.some((value) => value.requestId === requestId) || current.dispatchingRequestId === requestId)) return;
      try {
        const queue = await this.options.update(id, queueAction, requestId);
        if (this.disposed) return;
        if (queueAction === "remove" && item) {
          this.pendingBySession.set(id, this.pending(id).filter((value) => value !== item));
          this.clearError(id, item.display.id, "admission");
        }
        this.clearError(id, promptId, "operation");
        if (request) request.accepted = true;
        this.receive(id, queue);
        this.publish();
      } catch (error) { this.steering.delete(key); this.fail(id, error, promptId); }
    })();
    this.operations.set(key, operation);
    void operation.finally(() => {
      this.operations.delete(key);
      // An acknowledgement only accepts the steer. Keep presenting it until the
      // daemon reports dispatch, removal, failure or an explicit stop.
      if (request && !request.accepted) { this.steering.delete(key); this.publish(); }
    });
  }

  dispose(): void { this.disposed = true; }
}
