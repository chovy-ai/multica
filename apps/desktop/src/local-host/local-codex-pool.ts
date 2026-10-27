import { createHash } from "node:crypto";
import { CONTEXT_MCP_TOKEN_ENV } from "./local-context-mcp";
import { CodexContextBridge } from "./local-codex-context-bridge";
import { LocalCodexWorker, type CodexInput } from "./local-codex-worker";
import type { runLocalProvider } from "./local-provider-runner";
import type { LocalTimingStage } from "@multica/tutti-agent-gui-host/local-timing";

type Emit = Parameters<typeof runLocalProvider>[1];
interface Slot { worker: LocalCodexWorker; epoch?: string; busy: number; basis: string }
function digest(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, sort(value)])) : item;
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
}

/** Owned only by the local dialogue service. Two slots bound process count during config rotation. */
export class LocalCodexPool {
  private bridge = new CodexContextBridge();
  private slots: Slot[] = [];
  private active?: Slot;
  private admission: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private shutdown?: Promise<void>;
  private waiters = new Set<() => void>();
  private threads = new Set<string>();
  private latest?: { create(): Slot; epoch: string };
  constructor(private find: () => Promise<string | null>, private unloadGraceMs = 15_000) {}

  async run(scope: string, input: CodexInput, emit: Emit, signal: AbortSignal): Promise<{ output: string; sessionId: string }> {
    if (input.provider !== "codex" || input.titleOnly) throw new Error("The Codex pool is restricted to local dialogue turns");
    const timed = <T>(stage: LocalTimingStage, action: () => Promise<T>) => input.timing ? input.timing.measure(stage, action) : action();
    const created = new Set<LocalCodexWorker>();
    const admitted = this.admission.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      if (this.stopping) throw new Error("Codex dialogue pool stopped");
      const binary = await timed("provider.lookup", () => this.find());
      if (!binary) throw new Error("Codex is not installed on this computer.");
      await timed("provider.bridge", () => this.bridge.start());
      signal.throwIfAborted();
      if (this.stopping) throw new Error("Codex dialogue pool stopped");
      // Per-run Multica credentials/paths must never become another thread's inherited environment.
      const env = Object.fromEntries(Object.entries(input.env ?? process.env).filter(([key]) => !key.toUpperCase().startsWith("MULTICA_")));
      env[CONTEXT_MCP_TOKEN_ENV] = this.bridge.token;
      const basis = digest([scope, binary, env]);
      const create = (recordTiming = false): Slot => {
        const worker = new LocalCodexWorker(binary, input.cwd, env, this.bridge, this.unloadGraceMs);
        if (recordTiming) { created.add(worker); input.timing?.mark("provider.pool_create"); }
        return { worker, busy: 0, basis };
      };
      if (!this.slots.length) {
        this.slots.push(create(true), create(true));
        // The standby handshake runs concurrently and never delays the active instance or submits a prompt.
        await timed("provider.handshake", () => this.slots[0]!.worker.rpc.ready);
      }
      for (const slot of this.slots) if (!slot.busy && !slot.worker.available) {
        await slot.worker.stop(); Object.assign(slot, create(true));
      }
      let probe = this.slots.find((slot) => slot.basis === basis && slot.worker.available);
      if (!probe) {
        probe = await timed("provider.pool_wait", () => this.idle(signal));
        await probe.worker.stop(); Object.assign(probe, create(true));
      }
      let native = await timed("provider.config", () => probe!.worker.config(input.cwd));
      const version = () => digest([basis, native, [...(input.mcp?.tools ?? [])].sort(), Boolean(input.mcp)]);
      let epoch = version();
      if (this.slots.every((value) => !value.epoch && value.basis === basis)) for (const value of this.slots) value.epoch = epoch;
      let slot = this.slots.find((value) => value.epoch === epoch && value.worker.available);
      if (!slot) {
        slot = this.slots.find((value) => !value.epoch && value.basis === basis && value.worker.available);
        if (!slot) {
          slot = await timed("provider.pool_wait", () => this.idle(signal));
          await slot.worker.stop(); Object.assign(slot, create(true));
          await timed("provider.handshake", () => slot!.worker.rpc.ready);
          // Config may have changed again while both old generations were draining.
          native = await timed("provider.config", () => slot!.worker.config(input.cwd)); epoch = version();
        }
        slot.epoch = epoch;
      }
      signal.throwIfAborted();
      if (this.stopping) throw new Error("Codex dialogue pool stopped");
      if (input.resume && this.threads.has(input.resume)) throw new Error("This Codex thread already has an active turn");
      if (input.resume) this.threads.add(input.resume);
      this.latest = { create, epoch };
      if (!created.has(slot.worker)) input.timing?.mark("provider.pool_reused");
      this.active = slot; slot.busy++;
      return { slot, native };
    });
    this.admission = admitted;
    const { slot, native } = await timed("provider.pool_admission", () => admitted);
    let threadId = input.resume;
    try { return await slot.worker.run({ ...input, onSessionId: (id) => { threadId = id; this.threads.add(id); input.onSessionId?.(id); } }, native, emit, signal); }
    finally {
      if (threadId) this.threads.delete(threadId); slot.busy--;
      for (const wake of this.waiters) wake();
      this.rewarm(slot);
    }
  }
  private rewarm(slot: Slot): void {
    const maintenance = this.admission.catch(() => {}).then(async () => {
      if (this.stopping || slot.busy || slot === this.active || !this.latest || slot.epoch === this.latest.epoch) return;
      await slot.worker.stop();
      if (this.stopping) return;
      Object.assign(slot, this.latest.create()); slot.epoch = this.latest.epoch;
      await slot.worker.rpc.ready;
    });
    this.admission = maintenance; void maintenance.catch(() => {});
  }
  private async idle(signal: AbortSignal): Promise<Slot> {
    while (true) {
      signal.throwIfAborted();
      if (this.stopping) throw new Error("Codex dialogue pool stopped");
      const free = this.slots.find((slot) => !slot.busy && slot !== this.active) ?? this.slots.find((slot) => !slot.busy);
      if (free) return free;
      await new Promise<void>((resolve) => {
        const wake = () => { this.waiters.delete(wake); signal.removeEventListener("abort", wake); resolve(); };
        this.waiters.add(wake); signal.addEventListener("abort", wake, { once: true });
      });
    }
  }
  stop(): Promise<void> {
    return this.shutdown ??= (async () => {
      this.stopping = true; for (const wake of this.waiters) wake();
      await Promise.allSettled(this.slots.map((slot) => slot.worker.stop()));
      await this.admission.catch(() => {});
      // Admission may have been in the middle of starting an instance when shutdown began.
      await Promise.allSettled(this.slots.map((slot) => slot.worker.stop()));
      await this.bridge.stop();
    })();
  }
}
