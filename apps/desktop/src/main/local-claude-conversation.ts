import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { LocalBackgroundTask, LocalConversationEvent } from "@multica/tutti-agent-gui-host/local-protocol";
import { CONTEXT_MCP_NAME } from "./local-context-mcp";
import { findLocalProvider, ProviderStream, type runLocalProvider } from "./local-provider-runner";
import { readClaudePluginSettings } from "./local-provider-extensions";
import { readBackgroundTaskOutput } from "./local-background-task-output";

type Input = Parameters<typeof runLocalProvider>[0];
type Emit = (event: Omit<LocalConversationEvent, "seq" | "created_at">) => void;
type Result = { output: string; sessionId?: string };
export interface ClaudeRunObserver {
  tasks(tasks: LocalBackgroundTask[]): void;
  reply(content: string): void;
}
interface Run {
  id: ReturnType<typeof randomUUID>; parser: ProviderStream; observer: ClaudeRunObserver;
  settled: boolean; resultSeen: boolean; finalReply: boolean;
  resolve(value: Result): void; reject(error: Error): void; release(): void; session?(id: string): void;
}
interface Dependencies {
  query(prompt: AsyncIterable<SDKUserMessage>, options: Options): Promise<Query>;
  find(): Promise<string | null>;
  pluginSettings: typeof readClaudePluginSettings;
}
const dependencies: Dependencies = {
  query: async (prompt, options) => (await import("@anthropic-ai/claude-agent-sdk")).query({ prompt, options }),
  find: () => findLocalProvider("claude"),
  pluginSettings: readClaudePluginSettings,
};
function replyEnded(event: Record<string, any>): boolean {
  return (event.type === "assistant" && event.message?.stop_reason === "end_turn")
    || (event.type === "stream_event" && event.event?.type === "message_delta" && event.event.delta?.stop_reason === "end_turn");
}

/** One duplex CLI owns the native session, including its background shell tasks. */
export class LocalClaudeConversation {
  private query?: Query;
  private controller = new AbortController();
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private runs: Run[] = [];
  private active?: Run;
  private frameOwner?: Run;
  private notificationOwner?: Run;
  private delivery?: ProviderStream;
  private tasks = new Map<string, { value: LocalBackgroundTask; owner: Run; background: boolean }>();
  private outputPaths = new Map<string, string>();
  private outputTimer?: ReturnType<typeof setInterval>;
  private outputRead?: Promise<void>;
  private model?: string | null;
  private permission?: Input["permissionMode"];
  private sessionId?: string;
  private pump?: Promise<void>;
  private closeRequested = false;
  private closed = false;
  private disposal?: Promise<void>;
  constructor(private onClose: () => Promise<void>, private deps: Dependencies = dependencies) {}
  get available(): boolean { return !this.closeRequested && !this.closed; }
  get signal(): AbortSignal { return this.controller.signal; }
  private dispose(): Promise<void> { return this.disposal ??= (async () => { this.closed = true; await this.onClose(); })(); }
  async stop(): Promise<void> {
    this.closeRequested = true; this.controller.abort(); this.wake?.(); this.query?.close();
    await this.pump;
    await this.dispose();
  }
  async stopBackground(): Promise<void> {
    for (const task of this.tasks.values()) if (task.background && task.value.status === "running") {
      await this.query?.stopTask(task.value.id);
      if (task.value.status === "running") task.value = { ...task.value, status: "cancelled" };
    }
    this.publishTasks();
  }
  async run(input: Input, emit: Emit, signal: AbortSignal, observer: ClaudeRunObserver): Promise<Result> {
    if (!this.available || this.active) throw new Error("Claude conversation is not ready for another message");
    signal.throwIfAborted();
    let run!: Run;
    const result = new Promise<Result>((resolve, reject) => {
      const abort = () => { void this.stop(); };
      run = { id: randomUUID(), parser: new ProviderStream("claude", emit), observer, resolve, reject,
        settled: false, resultSeen: false, finalReply: false, release: () => signal.removeEventListener("abort", abort), session: input.onSessionId };
      signal.addEventListener("abort", abort, { once: true });
    });
    this.active = run; this.runs.push(run);
    // Initialization errors may arrive before the caller starts awaiting the result.
    void result.catch(() => {});
    try {
      if (!this.query) {
        const binary = await this.deps.find();
        if (!binary) throw new Error("Claude Code is not installed on this computer.");
        signal.throwIfAborted();
        const mcpServers = await this.mcpServers(input);
        const settings = await this.deps.pluginSettings(input.cwd, input.env ?? process.env);
        this.model = input.model; this.permission = input.permissionMode;
        this.query = await this.deps.query(this.messages(), {
          pathToClaudeCodeExecutable: binary, cwd: input.cwd, env: input.env,
          abortController: this.controller, includePartialMessages: true,
          settingSources: ["user", "project", "local"],
          settings, plugins: [], strictMcpConfig: true,
          ...(input.resume ? { resume: input.resume } : {}), ...(input.model ? { model: input.model } : {}),
          ...(input.permissionMode && input.permissionMode !== "default" ? { permissionMode: input.permissionMode === "auto" ? "auto" : "bypassPermissions" } : {}),
          ...(input.systemPrompt ? { systemPrompt: { type: "preset", preset: "claude_code", append: input.systemPrompt, snapshot: false } } : {}),
          mcpServers, allowedTools: [`mcp__${CONTEXT_MCP_NAME}__*`],
        });
        this.pump = this.consume().finally(() => this.dispose());
        void this.pump.catch(() => {});
      } else {
        // Strict MCP mode keeps dynamic updates limited to this Multica execution.
        const changed = await this.query.setMcpServers(await this.mcpServers(input));
        if (Object.keys(changed.errors).length) throw new Error("Could not refresh Multica context for this message");
        if (input.model !== this.model) { await this.query.setModel(input.model ?? undefined); this.model = input.model; }
        if (input.permissionMode !== this.permission) {
          await this.query.setPermissionMode(input.permissionMode === "full-access" ? "bypassPermissions" : input.permissionMode === "auto" ? "auto" : "default");
          this.permission = input.permissionMode;
        }
      }
      signal.throwIfAborted(); this.controller.signal.throwIfAborted();
      this.frameOwner = run;
      this.queue.push({ type: "user", uuid: run.id, session_id: this.sessionId ?? input.resume ?? "", parent_tool_use_id: null, message: { role: "user", content: input.content } });
      this.wake?.();
      const value = await result;
      return value;
    } catch (error) {
      this.finish(run, error instanceof Error ? error : new Error(String(error)));
      await this.stop(); throw error;
    }
  }
  private async mcpServers(input: Input): Promise<NonNullable<Options["mcpServers"]>> {
    if (!input.mcp) return {};
    const config = JSON.parse(await readFile(input.mcp.claudeConfigPath, "utf8"));
    if (!config.mcpServers?.[CONTEXT_MCP_NAME]) throw new Error("Multica context registration is missing");
    return { [CONTEXT_MCP_NAME]: config.mcpServers[CONTEXT_MCP_NAME] };
  }
  private async *messages(): AsyncGenerator<SDKUserMessage> {
    while (!this.controller.signal.aborted) {
      const message = this.queue.shift();
      if (message) yield message;
      else await new Promise<void>((resolve) => { this.wake = resolve; if (this.queue.length || this.controller.signal.aborted) resolve(); });
    }
  }
  private finish(run: Run, error?: Error): void {
    if (run.settled) return;
    run.settled = true; run.release(); if (this.active === run) this.active = undefined;
    if (error) run.reject(error);
    else run.resolve({ output: run.parser.output, sessionId: this.sessionId });
  }
  private publishTasks(): void {
    const readableTasks = [...this.tasks.values()].some((task) => task.background && task.value.status === "running" && this.outputPaths.has(task.value.id));
    if (!this.controller.signal.aborted && readableTasks && !this.outputTimer) {
      this.outputTimer = setInterval(() => { void this.refreshTaskOutputs(); }, 1000);
      this.outputTimer.unref();
    } else if ((!readableTasks || this.controller.signal.aborted) && this.outputTimer) {
      clearInterval(this.outputTimer); this.outputTimer = undefined;
    }
    for (const owner of this.runs) owner.observer.tasks([...this.tasks.values()].filter((task) => task.background && task.owner === owner).map((task) => task.value));
    // A foreground reply may precede the background membership snapshot.
    if (this.active?.finalReply && this.hasBackgroundTasks()) this.finish(this.active);
  }
  private hasBackgroundTasks(): boolean { return [...this.tasks.values()].some((task) => task.background && task.value.status === "running"); }
  private refreshTaskOutputs(): Promise<void> {
    return this.outputRead ??= (async () => {
      let changed = false;
      await Promise.all([...this.outputPaths].map(async ([id, path]) => {
        const task = this.tasks.get(id);
        if (!task?.background || task.value.status !== "running") return;
        const output = await readBackgroundTaskOutput(path);
        if (this.controller.signal.aborted || task.value.status !== "running" || output.output === undefined || (output.output === task.value.output && output.outputTruncated === task.value.outputTruncated)) return;
        task.value = { ...task.value, ...output, updatedAt: new Date().toISOString() }; changed = true;
      }));
      if (changed) this.publishTasks();
    })().finally(() => { this.outputRead = undefined; });
  }
  private captureTaskOutput(event: Record<string, any>): void {
    const id = event.tool_use_result?.backgroundTaskId;
    const task = typeof id === "string" ? this.tasks.get(id) : undefined;
    if (!task || task.value.status !== "running" || task.value.taskType !== "local_bash" || !this.sessionId) return;
    for (const block of event.message?.content ?? []) {
      if (block.type !== "tool_result" || typeof block.content !== "string" || (task.value.toolUseId && block.tool_use_id !== task.value.toolUseId)) continue;
      const path = /Output is being written to: (.+?\.output)(?:\. |$)/.exec(block.content)?.[1];
      // Match the native session/task locator, never arbitrary paths in command output.
      if (!path || !isAbsolute(path) || basename(path) !== `${id}.output` || basename(dirname(path)) !== "tasks" || basename(dirname(dirname(path))) !== this.sessionId) continue;
      task.background = true; task.value.toolUseId = block.tool_use_id;
      this.outputPaths.set(id, path); this.publishTasks(); void this.refreshTaskOutputs();
    }
  }
  private async consume(): Promise<void> {
    let failure: Error | undefined;
    try {
      for await (const message of this.query!) {
        // SDK envelopes are narrowed below; ignore subagent transcript frames.
        const event = message as unknown as Record<string, any>;
        if (event.parent_tool_use_id) continue;
        if (typeof event.session_id === "string" && event.session_id !== this.sessionId) { this.sessionId = event.session_id; this.active?.session?.(event.session_id); }
        if (event.type === "user") this.captureTaskOutput(event);
        if (event.type === "system" && ["task_started", "task_progress", "task_updated", "background_tasks_changed", "task_notification"].includes(event.subtype)) {
          const now = new Date().toISOString();
          if (event.subtype === "task_notification") {
            const task = this.tasks.get(event.task_id);
            if (task) {
              task.value = { ...task.value, status: event.status === "stopped" ? "cancelled" : event.status, summary: event.summary, updatedAt: now, completedAt: now, ...taskUsage(event.usage) };
              if (task.background) {
                this.notificationOwner = task.owner;
                this.publishTasks();
                if (task.value.taskType === "local_bash" && typeof event.output_file === "string" && event.output_file) {
                  Object.assign(task.value, await readBackgroundTaskOutput(event.output_file));
                }
              }
            }
          } else if (event.subtype === "task_progress" || event.subtype === "task_updated") {
            const task = this.tasks.get(event.task_id);
            if (task && task.value.status === "running") {
              const patch = event.subtype === "task_updated" ? event.patch ?? {} : event;
              if (typeof patch.is_backgrounded === "boolean") task.background = patch.is_backgrounded;
              task.value = { ...task.value, updatedAt: now, ...taskUsage(event.usage),
                ...(typeof patch.description === "string" ? { description: patch.description } : {}),
                ...(typeof event.summary === "string" ? { progressSummary: event.summary } : {}),
                ...(typeof event.last_tool_name === "string" ? { lastToolName: event.last_tool_name } : {}),
              };
              const status = { completed: "completed", failed: "failed", killed: "cancelled" }[patch.status as string];
              if (status) task.value = { ...task.value, status: status as LocalBackgroundTask["status"], completedAt: now, ...(typeof patch.error === "string" ? { summary: patch.error } : {}) };
            }
          } else {
            const values = event.subtype === "task_started" ? [event] : Array.isArray(event.tasks) ? event.tasks : [];
            if (event.subtype === "background_tasks_changed") {
              const live = new Set(values.map((task: Record<string, unknown>) => task.task_id));
              for (const [id, task] of this.tasks) if (task.background && task.value.status === "running" && !live.has(id)) task.value = { ...task.value, status: "completed", completedAt: now, updatedAt: now };
            }
            for (const task of values) {
              if (typeof task.task_id !== "string") continue;
              const previous = this.tasks.get(task.task_id);
              const owner = previous?.owner ?? this.active ?? this.frameOwner;
              if (owner) this.tasks.set(task.task_id, { owner,
                background: event.subtype === "background_tasks_changed" || task.is_backgrounded !== false,
                value: { ...previous?.value, id: task.task_id, description: task.description || previous?.value.description || "Background task", status: event.subtype === "task_started" ? previous?.value.status ?? "running" : "running", ambient: task.ambient ?? previous?.value.ambient ?? false, createdAt: previous?.value.createdAt ?? now,
                  ...(typeof task.tool_use_id === "string" ? { toolUseId: task.tool_use_id } : {}),
                  ...(typeof task.task_type === "string" ? { taskType: task.task_type } : {}),
                } });
            }
          }
          this.publishTasks(); continue;
        }
        const uuid = event.user_message_uuid ?? event.user_message_uuids?.at(-1);
        const bound = typeof uuid === "string" ? this.runs.find((run) => run.id === uuid) : undefined;
        if (bound) this.frameOwner = bound;
        const owner = bound ?? (event.type === "result" ? this.runs.find((run) => !run.resultSeen) : this.frameOwner ?? this.active);
        if (event.type === "result") {
          if (!owner) continue;
          owner.resultSeen = true;
          if (!owner.settled) { owner.parser.accept(JSON.stringify(event)); this.finish(owner, owner.parser.error ? new Error(owner.parser.error) : undefined); }
          if (!this.active && !this.hasBackgroundTasks()) { this.closeRequested = true; this.query!.close(); break; }
          continue;
        }
        if (owner && !owner.settled) {
          owner.parser.accept(JSON.stringify(event));
          if (replyEnded(event)) {
            owner.finalReply = true;
            if (this.hasBackgroundTasks()) this.finish(owner);
          }
        } else if (this.notificationOwner && (!bound || bound === this.notificationOwner) && (event.type === "stream_event" || event.type === "assistant")) {
          this.delivery ??= new ProviderStream("claude", () => {});
          this.delivery.accept(JSON.stringify(event));
          if (replyEnded(event)) {
            if (this.delivery.output.trim()) this.notificationOwner.observer.reply(this.delivery.output);
            this.delivery = undefined; this.notificationOwner = undefined;
          }
        }
      }
    } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    finally {
      this.closeRequested = true; this.controller.abort(); this.wake?.(); this.query?.close();
      for (const run of this.runs) this.finish(run, failure ?? new Error("Claude conversation stopped before finishing this message"));
      for (const task of this.tasks.values()) if (task.value.status === "running") task.value = { ...task.value, status: failure ? "failed" : "cancelled" };
      this.publishTasks();
    }
  }
}

function taskUsage(value: unknown): Pick<LocalBackgroundTask, "usage"> {
  if (!value || typeof value !== "object") return {};
  const usage = value as Record<string, unknown>;
  const values = [usage.total_tokens, usage.tool_uses, usage.duration_ms];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return {};
  return { usage: { totalTokens: usage.total_tokens as number, toolUses: usage.tool_uses as number, durationMs: usage.duration_ms as number } };
}
