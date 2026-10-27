import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); }
}
/** An application error with a stable machine-readable code, as the daemon emits. */
export const appError = (code: string, message: string) => new RpcError(-32000, message, { code });

type Handler = (method: string, params: unknown) => unknown;
interface Message { jsonrpc: "2.0"; id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }

const MAX_MESSAGE_BYTES = 1 << 20;

/**
 * Newline-delimited JSON-RPC 2.0 peer over a stream pair, matching the daemon's
 * framing. Requests are served concurrently; notifications run in arrival order
 * because events carry sequence numbers.
 */
export class JsonRpcPeer {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private notes: Promise<void> = Promise.resolve();
  private closedError?: Error;
  readonly closed: Promise<void>;

  constructor(input: Readable, private output: Writable, private handler: Handler) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => this.receive(line));
    this.closed = new Promise((resolve) => lines.once("close", () => { this.fail(new Error("connection closed")); resolve(); }));
  }

  private fail(error: Error): void {
    this.closedError ??= error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let message: Message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.jsonrpc !== "2.0") return;
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
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new Error("message exceeds 1 MiB");
    this.output.write(`${line}\n`);
  }

  notify(method: string, params: unknown): void {
    try { this.write({ jsonrpc: "2.0", method, params }); } catch { /* A closed peer drops notifications. */ }
  }

  call<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { this.pending.delete(id); reject(signal!.reason ?? new Error("aborted")); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value as T); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
      });
      try { this.write({ jsonrpc: "2.0", id, method, params }); } catch (error) { this.pending.delete(id); reject(error as Error); }
    });
  }
}
