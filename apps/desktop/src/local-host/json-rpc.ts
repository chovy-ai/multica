import { createInterface } from "node:readline";
import { errorMonitor } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { RpcDiagnostics } from "./rpc-diagnostics";

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}
/** An application error with a stable machine-readable code, as the daemon emits. */
export const appError = (code: string, message: string) => new RpcError(-32000, message, { code });

type Handler = (method: string, params: unknown) => unknown;
interface Message { jsonrpc: "2.0"; id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }

/** Moves whole JSON-RPC messages; framing belongs to the transport. */
export interface MessageTransport {
  diagnostics?: RpcDiagnostics;
  send(text: string): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
}

/** Newline-delimited framing over a stream pair, as the daemon uses for the sidecar. */
export function lineTransport(input: Readable, output: Writable, diagnostics?: RpcDiagnostics): MessageTransport {
  const lines = createInterface({ input, crlfDelay: Infinity });
  if (diagnostics) {
    // Observe errors without handling them or changing the existing crash behavior.
    input.on(errorMonitor, (error) => diagnostics.record("input_error", error));
    output.on(errorMonitor, (error) => diagnostics.record("output_error", error));
    lines.once("close", () => diagnostics.record("input_closed"));
  }
  return {
    diagnostics,
    send: (text) => {
      if (!diagnostics) { output.write(`${text}\n`); return; }
      const bytes = Buffer.byteLength(text) + 1;
      diagnostics.queued(bytes);
      try { output.write(`${text}\n`, (error) => diagnostics.written(bytes, error)); }
      catch (error) { diagnostics.written(bytes); diagnostics.record("write_throw", error); throw error; }
    },
    onMessage: (listener) => { lines.on("line", listener); },
    onClose: (listener) => { lines.once("close", listener); },
  };
}

/**
 * JSON-RPC 2.0 peer. Requests are served concurrently; notifications run in
 * arrival order because events carry sequence numbers.
 */
export class JsonRpcPeer {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private notes: Promise<void> = Promise.resolve();
  private closedError?: Error;
  private transport: MessageTransport;
  private handler: Handler;
  readonly closed: Promise<void>;

  constructor(transport: MessageTransport, handler: Handler);
  constructor(input: Readable, output: Writable, handler: Handler);
  constructor(first: MessageTransport | Readable, second: Writable | Handler, third?: Handler) {
    this.transport = third ? lineTransport(first as Readable, second as Writable) : first as MessageTransport;
    this.handler = (third ?? second) as Handler;
    this.transport.onMessage((text) => this.receive(text));
    this.closed = new Promise((resolve) => this.transport.onClose(() => { this.fail(new Error("connection closed")); resolve(); }));
  }

  private fail(error: Error): void {
    this.closedError ??= error;
    for (const [id, entry] of this.pending) { this.transport.diagnostics?.forgetCall(id); entry.reject(error); }
    this.pending.clear();
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let message: Message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.jsonrpc !== "2.0") return;
    this.transport.diagnostics?.frame("in", message, Buffer.byteLength(line));
    if (message.method === undefined) {
      if (message.id === undefined) return;
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!entry) return;
      if (message.error) entry.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else entry.resolve(message.result);
      return;
    }
    const { id, method, params } = message;
    if (id === undefined) {
      this.notes = this.notes.then(async () => { try { await this.handler(method, params); } catch { /* Notifications have no reply channel. */ } });
      return;
    }
    void (async () => {
      try { this.write({ jsonrpc: "2.0", id, result: (await this.handler(method, params)) ?? {} }); }
      catch (error) {
        const rpc = error instanceof RpcError ? error : new RpcError(-32603, error instanceof Error ? error.message : String(error));
        this.write({ jsonrpc: "2.0", id, error: { code: rpc.code, message: rpc.message, ...(rpc.data === undefined ? {} : { data: rpc.data }) } });
      }
    })();
  }

  private write(message: Message): void {
    if (this.closedError) throw this.closedError;
    const line = JSON.stringify(message);
    this.transport.diagnostics?.frame("out", message, Buffer.byteLength(line));
    this.transport.send(line);
  }

  notify(method: string, params: unknown): void {
    try { this.write({ jsonrpc: "2.0", method, params }); } catch { /* A closed peer drops notifications. */ }
  }

  call<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { this.pending.delete(id); this.transport.diagnostics?.forgetCall(id); reject(signal!.reason ?? new Error("aborted")); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value as T); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
      });
      try { this.write({ jsonrpc: "2.0", id, method, params }); } catch (error) { this.pending.delete(id); this.transport.diagnostics?.forgetCall(id); reject(error as Error); }
    });
  }
}
