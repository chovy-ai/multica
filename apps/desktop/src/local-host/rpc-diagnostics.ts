import { writeSync } from "node:fs";
import { LOCAL_CONVERSATION_METHODS } from "@multica/core/local-conversation/protocol";

interface Envelope { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; data?: unknown } }
type Fields = Record<string, unknown>;
type RequestInfo = Fields & { method: string; started: number };
const object = (value: unknown): Fields => value && typeof value === "object" ? value as Fields : {};
const rpcMethods = new Set(["init", "session.set", "request", "subscribe", "event", "timing", "busy", "host.request", "hostReply", "file.resolve", "file.commit", "drain", "undrain", "shutdown"]);
const identifier = (value: unknown) => typeof value === "string" && /^(?:[a-f0-9]{16}|[a-f0-9-]{36})$/i.test(value) ? value : undefined;

/** Metadata only. This sink bypasses Node's stream queue, including during a fatal stream error. */
export function writeRpcDiagnostic(record: Fields): void {
  try { writeSync(2, `[local-rpc] ${JSON.stringify(record)}\n`); } catch { /* Diagnostics must not replace the original failure. */ }
}

/** One-second summaries and immediate queue high-water/error snapshots, never payload contents. */
export class RpcDiagnostics {
  private incoming = new Map<number, RequestInfo>();
  private outgoing = new Map<number, RequestInfo>();
  private started: number;
  private frames = { in: 0, out: 0, inBytes: 0, outBytes: 0 };
  private methods: Record<string, number> = {};
  private errors: Record<string, number> = {};
  private largest?: Fields;
  private last?: Fields;
  private maxLatencyMs = 0;
  private failedWrites = 0;
  private queuedBytes = 0;
  private queuedFrames = 0;
  private peakQueuedBytes = 0;
  private peakQueuedFrames = 0;
  private nextPressure = 8 * 1024 * 1024;

  constructor(private sink: (record: Fields) => void = writeRpcDiagnostic, private now = Date.now) {
    this.started = now();
  }

  frame(direction: "in" | "out", message: Envelope, bytes: number): void {
    const own = direction === "in" ? this.incoming : this.outgoing;
    const opposite = direction === "in" ? this.outgoing : this.incoming;
    let info: Fields;
    if (message.method !== undefined) {
      const params = object(message.params);
      const args = object(params.params);
      const method = rpcMethods.has(message.method) ? message.method : "unknown";
      const operation = typeof params.method === "string" && Object.hasOwn(LOCAL_CONVERSATION_METHODS, params.method) ? params.method : undefined;
      info = { method, operation, connectionId: identifier(params.connectionId), conversationId: identifier(args.id), instance: identifier(params.instance) };
      if (typeof message.id === "number") own.set(message.id, { ...info, method, started: this.now() });
      const key = `${direction}:${operation ?? method}`;
      this.methods[key] = (this.methods[key] ?? 0) + 1;
    } else {
      const request = message.id === undefined ? undefined : opposite.get(message.id);
      if (message.id !== undefined) opposite.delete(message.id);
      info = request ? { ...request, started: undefined, latencyMs: this.now() - request.started } : { method: "response" };
      if (request) this.maxLatencyMs = Math.max(this.maxLatencyMs, this.now() - request.started);
      const result = object(message.result);
      if (Array.isArray(result.messages)) info.messageCount = result.messages.length;
      if (Array.isArray(result.turns)) {
        info.turnCount = result.turns.length;
        info.eventCount = result.turns.reduce((sum, turn) => sum + (Array.isArray(object(turn).events) ? (object(turn).events as unknown[]).length : 0), 0);
      }
      if (message.error) {
        const code = object(message.error.data).code;
        // Error messages may quote paths, commands, or provider content.
        const key = typeof code === "string" && ["session_required", "not_initialized", "account_mismatch", "host_draining", "method_not_allowed"].includes(code) ? code : String(message.error.code);
        info.errorCode = key;
        this.errors[key] = (this.errors[key] ?? 0) + 1;
      }
    }
    this.frames[direction]++;
    this.frames[direction === "in" ? "inBytes" : "outBytes"] += bytes;
    this.last = { direction, rpcId: message.id, ...info, bytes };
    if (!this.largest || bytes > (this.largest.bytes as number)) this.largest = this.last;
    if (info.errorCode && this.errors[info.errorCode as string] === 1) this.record("rpc_error");
    if (this.now() - this.started >= 1000) this.flush();
  }

  queued(bytes: number): void {
    this.queuedBytes += bytes;
    this.queuedFrames++;
    this.peakQueuedBytes = Math.max(this.peakQueuedBytes, this.queuedBytes);
    this.peakQueuedFrames = Math.max(this.peakQueuedFrames, this.queuedFrames);
    if (this.queuedBytes >= this.nextPressure) {
      this.record("write_pressure");
      while (this.nextPressure <= this.queuedBytes) this.nextPressure *= 2;
    }
  }

  forgetCall(id: number): void { this.outgoing.delete(id); }

  written(bytes: number, error?: Error | null): void {
    if (error && ++this.failedWrites === 1) this.record("write_failed", error);
    this.queuedBytes -= bytes;
    this.queuedFrames--;
    if (this.queuedFrames === 0) {
      if (this.nextPressure > 8 * 1024 * 1024) this.record("write_queue_empty");
      this.nextPressure = 8 * 1024 * 1024;
    }
  }

  record(event: string, error?: unknown): void {
    const details = object(error);
    const errorCode = typeof details.code === "string" && /^E[A-Z0-9_]{1,30}$/.test(details.code) ? details.code : undefined;
    const memory = process.memoryUsage();
    try {
      this.sink({ at: new Date(this.now()).toISOString(), pid: process.pid, ppid: process.ppid, event,
        windowMs: this.now() - this.started, ...this.frames, methods: { ...this.methods }, errors: { ...this.errors },
        activeRequests: this.incoming.size, pendingCalls: this.outgoing.size, maxLatencyMs: this.maxLatencyMs, failedWrites: this.failedWrites,
        queuedBytes: this.queuedBytes, queuedFrames: this.queuedFrames, peakQueuedBytes: this.peakQueuedBytes, peakQueuedFrames: this.peakQueuedFrames,
        largestFrame: this.largest, lastFrame: this.last, errorCode, rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external });
    } catch { /* Best effort even if a test or diagnostic sink fails. */ }
  }

  flush(): void {
    this.record("traffic");
    this.started = this.now();
    this.frames = { in: 0, out: 0, inBytes: 0, outBytes: 0 };
    this.methods = {}; this.errors = {}; this.largest = undefined; this.maxLatencyMs = 0; this.failedWrites = 0;
    this.peakQueuedBytes = this.queuedBytes; this.peakQueuedFrames = this.queuedFrames;
  }
}
