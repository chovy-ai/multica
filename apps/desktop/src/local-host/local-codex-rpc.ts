import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CODEX_PLUGIN_ISOLATION_ARGS } from "./local-provider-extensions";

// The native protocol has tagged, versioned envelopes; callers narrow by method/item type.
export type CodexObject = Record<string, any>;
export class CodexRpc {
  private child;
  private lines;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: CodexObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(message: CodexObject) => void>();
  private failure?: Error;
  private stopped?: Promise<void>;
  private exited: Promise<void>;
  readonly ready: Promise<void>;
  get available(): boolean { return !this.failure && !this.stopped; }
  constructor(binary: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(binary, [...CODEX_PLUGIN_ISOLATION_ARGS, "app-server", "--listen", "stdio://"], {
      cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
    });
    this.lines = createInterface({ input: this.child.stdout });
    // Provider stderr can contain credential-bearing config diagnostics. Never forward it to history.
    this.child.stderr.resume();
    this.exited = new Promise((resolve) => {
      this.child.once("error", () => { this.fail(new Error("Codex app-server could not start")); resolve(); });
      this.child.once("close", () => { this.fail(new Error("Codex app-server disconnected; the turn was not replayed")); this.lines.close(); resolve(); });
    });
    this.child.stdin.on("error", () => this.fail(new Error("Codex app-server transport closed")));
    this.lines.on("line", (line) => {
      let message: CodexObject;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== "object") return;
      if (typeof message.id === "number" && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error("Codex app-server rejected the protocol request"));
        else pending.resolve(message.result ?? {});
      } else for (const listener of this.listeners) listener(message);
    });
    this.ready = this.request("initialize", { clientInfo: { name: "multica_dialogue", title: "Multica", version: "1.0.0" } }, 10_000)
      .then(() => { this.write({ method: "initialized" }); });
    void this.ready.catch(() => {});
  }
  subscribe(listener: (message: CodexObject) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  request(method: string, params: CodexObject, timeoutMs = 15_000): Promise<CodexObject> {
    if (this.failure || this.stopped) return Promise.reject(this.failure ?? new Error("Codex app-server stopped"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Codex app-server ${method} timed out; the turn was not replayed`));
        void this.stop();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  respond(id: number | string, result: CodexObject): void { this.write({ id, result }); }
  unsupported(id: number | string): void { this.write({ id, error: { code: -32601, message: "This request is unavailable in the local conversation host" } }); }
  private write(message: CodexObject): void {
    if (this.failure) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) this.fail(new Error("Codex app-server write failed")); });
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: "transport/closed", error });
  }
  stop(): Promise<void> {
    return this.stopped ??= (async () => {
      this.fail(new Error("Codex app-server stopped")); this.child.stdin.end();
      const kill = (signal: NodeJS.Signals) => {
        if (!this.child.pid || this.child.exitCode !== null) return;
        try { if (process.platform === "win32") this.child.kill(); else process.kill(-this.child.pid, signal); } catch { /* Already stopped. */ }
      };
      kill("SIGTERM"); const timer = setTimeout(() => kill("SIGKILL"), 2000);
      await this.exited; clearTimeout(timer);
    })();
  }
}
