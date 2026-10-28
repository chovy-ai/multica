import { randomUUID } from "node:crypto";
import { CONTEXT_MCP_NAME, CONTEXT_MCP_TOKEN_ENV } from "./local-context-mcp";
import { CodexRpc, type CodexObject } from "./local-codex-rpc";
import { CodexTurnStream } from "./local-codex-stream";
import type { CodexContextBridge } from "./local-codex-context-bridge";
import type { runLocalProvider } from "./local-provider-runner";
import { localTimingFailure, type LocalTiming, type LocalTimingStage } from "@multica/tutti-agent-gui-host/local-timing";

export type CodexInput = Parameters<typeof runLocalProvider>[0];
type Emit = Parameters<typeof runLocalProvider>[1];

export class LocalCodexWorker {
  readonly rpc: CodexRpc;
  private unloading = new Map<string, Promise<void>>();
  private activeThreads = new Set<string>();
  private retiring = false;
  get available(): boolean { return this.rpc.available && !this.retiring; }
  constructor(binary: string, cwd: string, env: NodeJS.ProcessEnv, private bridge: CodexContextBridge, private unloadGraceMs = 15_000) {
    this.rpc = new CodexRpc(binary, cwd, env);
  }
  async config(cwd: string): Promise<CodexObject> {
    await this.rpc.ready;
    const result = await this.rpc.request("config/read", { cwd, includeLayers: false });
    if (!result.config || typeof result.config !== "object" || Array.isArray(result.config)) throw new Error("Invalid Codex configuration response");
    if ((result.config.developer_instructions != null && typeof result.config.developer_instructions !== "string")
      || (result.config.mcp_servers != null && (typeof result.config.mcp_servers !== "object" || Array.isArray(result.config.mcp_servers)))) throw new Error("Invalid Codex configuration response");
    return result.config;
  }
  stop(): Promise<void> { return this.rpc.stop(); }

  async waitForThread(threadId: string, signal: AbortSignal, timing?: LocalTiming): Promise<void> {
    signal.throwIfAborted();
    const pending = this.unloading.get(threadId);
    if (!pending) return;
    const wait = () => new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
    await (timing ? timing.measure("provider.thread_wait", wait) : wait());
  }

  async run(input: CodexInput, native: CodexObject, emit: Emit, signal: AbortSignal): Promise<{ output: string; sessionId: string }> {
    const timed = <T>(stage: LocalTimingStage, action: () => Promise<T>) => input.timing ? input.timing.measure(stage, action) : action();
    if (input.resume) await this.waitForThread(input.resume, signal, input.timing);
    signal.throwIfAborted();
    let model = input.model ?? native.model ?? null;
    if (input.resume && !model) {
      // An explicit model override prevents resume from restoring a previous effort.
      const catalog = await this.rpc.request("model/list", { limit: 100 });
      model = catalog.data?.find((entry: CodexObject) => entry.isDefault)?.id;
      if (typeof model !== "string" || !model) throw new Error("Could not resolve the default Codex model. Select a model explicitly and retry.");
    }
    const id = randomUUID();
    const env = input.env ?? process.env;
    const mcpServers: CodexObject = Object.create(null);
    for (const name of Object.keys(native.mcp_servers ?? {})) mcpServers[name] = { enabled: false };
    if (input.mcp) {
      if (Object.hasOwn(mcpServers, CONTEXT_MCP_NAME)) throw new Error("Native Codex settings use the reserved Multica MCP name multica_desktop_context");
      const token = env[CONTEXT_MCP_TOKEN_ENV];
      if (!token) throw new Error("Multica MCP credentials are unavailable");
      const url = this.bridge.bind(id, { url: input.mcp.url, token, signal });
      mcpServers[CONTEXT_MCP_NAME] = { url, bearer_token_env_var: CONTEXT_MCP_TOKEN_ENV, enabled: true, required: true, default_tools_approval_mode: "auto", tool_timeout_sec: 3600 };
    }
    // These are non-secret locations and scope identifiers. MCP credentials stay in the bridge.
    const scopedEnv = Object.fromEntries(["MULTICA_TASK_CONFIG_ROOT", "MULTICA_SERVER_URL", "MULTICA_WORKSPACE_ID", "MULTICA_SETTINGS_MCP_URL"]
      .filter((name) => env[name] !== undefined).map((name) => [name, name === "MULTICA_SETTINGS_MCP_URL" && input.mcp ? mcpServers[CONTEXT_MCP_NAME].url : env[name]]));
    const config = { ...(input.reasoningEffort ? { model_reasoning_effort: input.reasoningEffort } : {}), mcp_servers: mcpServers, shell_environment_policy: { set: scopedEnv } };
    const permissions = input.permissionMode === "auto" ? { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write" }
      : input.permissionMode === "full-access" ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {};
    const params = { cwd: input.cwd, model, config,
      developerInstructions: [native.developer_instructions, input.systemPrompt].filter(Boolean).join("\n\n") || null, ...permissions,
      ...(input.resume ? { threadId: input.resume, excludeTurns: true } : {}),
    };
    let threadId: string | undefined;
    let unsubscribe: (() => void) | undefined;
    let abort: (() => void) | undefined;
    let interruptTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const setup = await timed("provider.thread_ready", () => this.rpc.request(input.resume ? "thread/resume" : "thread/start", params, 60_000));
      threadId = setup.thread?.id;
      if (typeof threadId !== "string" || !threadId) throw new Error("Codex returned no thread ID");
      if (this.activeThreads.has(threadId)) throw new Error("This Codex thread already has an active turn");
      this.activeThreads.add(threadId);
      input.onSessionId?.(threadId);
      signal.throwIfAborted();
      const stream = new CodexTurnStream(emit);
      let turnId: string | undefined; let interrupting = false;
      let resolveTurn!: () => void; let rejectTurn!: (error: Error) => void;
      const done = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
      void done.catch(() => {});
      const interrupt = () => {
        if (!turnId || interrupting) return;
        interrupting = true;
        void this.rpc.request("turn/interrupt", { threadId, turnId }, 10_000).catch(rejectTurn);
        interruptTimer = setTimeout(() => { rejectTurn(new Error("Codex did not confirm interruption")); void this.rpc.stop(); }, 15_000);
      };
      abort = () => interrupt();
      signal.addEventListener("abort", abort, { once: true });
      const buffered: CodexObject[] = [];
      const receive = (message: CodexObject) => {
        if (message.method === "transport/closed") { rejectTurn(message.error); return; }
        const event = message.params;
        if (!event || event.threadId !== threadId) return;
        // Resume can replay old notifications. Only the turn/start response establishes the new turn.
        if (!turnId) { buffered.push(message); return; }
        if ((event.turnId && event.turnId !== turnId) || (event.turn?.id && event.turn.id !== turnId)) return;
        input.timing?.activity(); input.timing?.once("provider.first_event");
        if (message.method === "error" && event.willRetry) input.timing?.mark("provider.retry", { failure: localTimingFailure(event.error?.message) });
        if (message.id !== undefined) {
          // The local GUI has no command-approval surface. Never interpret a clarification as approval.
          if (message.method === "item/permissions/requestApproval") this.rpc.respond(message.id, { permissions: {}, scope: "turn" });
          else if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") this.rpc.respond(message.id, { decision: "cancel" });
          else if (message.method === "mcpServer/elicitation/request") this.rpc.respond(message.id, { action: "cancel", content: null });
          else this.rpc.unsupported(message.id);
          emit({ type: "status", content: "Codex requested unsupported interactive input; this request was declined by the conversation host." });
          return;
        }
        stream.accept(message.method, event);
        if (message.method === "error" && !event.willRetry) emit({ type: "status", content: "Codex reported an execution error" });
        if (message.method === "turn/completed") {
          input.timing?.mark("provider.result", { outcome: event.turn.status === "completed" ? "completed" : event.turn.status === "interrupted" ? "cancelled" : "failed" });
          if (event.turn.status === "completed") resolveTurn();
          else rejectTurn(new Error(event.turn.status === "interrupted" ? "Execution cancelled" : "Codex turn failed"));
        }
      };
      unsubscribe = this.rpc.subscribe(receive);
      const started = await timed("provider.turn_start", () => this.rpc.request("turn/start", { threadId, effort: input.reasoningEffort ?? native.model_reasoning_effort ?? null, input: [{ type: "text", text: input.content, text_elements: [] }] }));
      if (typeof started.turn?.id === "string") turnId = started.turn.id;
      if (!turnId) throw new Error("Codex returned no turn ID");
      for (const message of buffered) receive(message); buffered.length = 0;
      if (signal.aborted) interrupt();
      await done;
      signal.throwIfAborted();
      return { output: stream.parser.output, sessionId: threadId };
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
      if (interruptTimer) clearTimeout(interruptTimer);
      unsubscribe?.();
      if (threadId) {
        this.activeThreads.delete(threadId);
        if (this.retiring && !this.activeThreads.size) void this.rpc.stop();
        const unload = () => this.unload(threadId!);
        void (input.timing ? input.timing.background("provider.thread_unload", unload) : unload()).catch(() => {});
      }
      this.bridge.release(id);
    }
  }
  private unload(threadId: string): Promise<void> {
    // A resumed, still-loaded thread can retain its old MCP snapshot. Wait for actual unload before reuse.
    let release!: () => void; let reject!: (error: Error) => void;
    const closed = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
    const unsubscribe = this.rpc.subscribe((message) => {
      if (message.method === "thread/closed" && message.params?.threadId === threadId) release();
      if (message.method === "transport/closed") reject(message.error);
    });
    const timer = setTimeout(() => {
      reject(new Error("Codex thread did not unload")); this.retiring = true;
      // A no-subscriber grace period is not a transport failure. Drain unrelated turns before recycling.
      if (!this.activeThreads.size) void this.rpc.stop();
    }, this.unloadGraceMs);
    const pending = (async () => {
      try {
        const result = await this.rpc.request("thread/unsubscribe", { threadId });
        if (result.status === "notLoaded") release();
        await closed;
      } finally { clearTimeout(timer); unsubscribe(); this.unloading.delete(threadId); }
    })();
    // closed can reject before the unsubscribe RPC settles.
    void closed.catch(() => {});
    this.unloading.set(threadId, pending); void pending.catch(() => {});
    return pending;
  }
}
