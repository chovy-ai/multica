// @vitest-environment node
import { createLocalTiming } from "@multica/tutti-agent-gui-host/local-timing";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { LocalClaudeConversation } from "./local-claude-conversation";
import { CONTEXT_MCP_NAME } from "./local-context-mcp";
import { readClaudePluginSettings } from "./local-provider-extensions";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
class Messages<T> {
  values: T[] = []; ended = false; wake?: () => void;
  push(value: T) { this.values.push(value); this.wake?.(); }
  end() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.values.length) {
      const value = this.values.shift();
      if (value !== undefined) yield value;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}
async function setup() {
  const output = new Messages<SDKMessage>();
  const received: SDKUserMessage[] = [];
  const transport = Object.assign(output, { applyFlagSettings: vi.fn(async () => {}), close: vi.fn(() => output.end()), setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })), setModel: vi.fn(), setPermissionMode: vi.fn(), stopTask: vi.fn(async () => {}) });
  const create = vi.fn(async (input: AsyncIterable<SDKUserMessage>, _options: Options) => { void (async () => { for await (const message of input) received.push(message); })(); return transport as unknown as Query; });
  const dispose = vi.fn(async () => {});
  const worker = new LocalClaudeConversation(dispose, { find: async () => "/test-owned/fake-claude", query: create, pluginSettings: async () => ({ enabledPlugins: { "fixture@market": false }, syncClaudeAiPlugins: false }) });
  cleanups.push(() => worker.stop());
  const emit = vi.fn(); const observer = { tasks: vi.fn(), reply: vi.fn() };
  const input = { provider: "claude" as const, cwd: "/test-owned/project", content: "Watch the PR", systemPrompt: "Existing Multica rules", env: { TEST_ONLY: "yes" } };
  const push = (message: unknown) => output.push(message as SDKMessage);
  const begin = async () => {
    const result = worker.run(input, emit, new AbortController().signal, observer);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    push({ type: "system", subtype: "init", session_id: "native-conversation" });
    return { result, uuid: received[0]!.uuid };
  };
  return { worker, create, transport, dispose, emit, observer, input, push, begin, received };
}
const reply = (uuid: string | undefined, text: string) => ({ type: "assistant", user_message_uuid: uuid, message: { stop_reason: "end_turn", content: [{ type: "text", text }] } });
const result = (uuid: string | undefined, text: string) => ({ type: "result", user_message_uuid: uuid, result: text, is_error: false });

describe("Claude foreground replies and background task ownership", () => {
  it("changes thinking effort on the reused SDK session and clears an explicit override", async () => {
    const f = await setup();
    let n = 0;
    for (const reasoningEffort of ["high", "low", null] as const) {
      const running = f.worker.run({ ...f.input, reasoningEffort }, f.emit, new AbortController().signal, f.observer);
      n++;
      await vi.waitFor(() => expect(f.received).toHaveLength(n), { interval: 5 });
      f.push({ type: "system", subtype: "task_started", task_id: "background", description: "Keep transport open" });
      f.push(reply(f.received[n - 1]!.uuid, "Reply")); f.push(result(f.received[n - 1]!.uuid, "Reply"));
      await running;
    }
    expect(f.create.mock.calls[0]?.[1]).toMatchObject({ effort: "high" });
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.transport.applyFlagSettings.mock.calls).toEqual([[{ effortLevel: "low" }], [{ effortLevel: null }]]);
  });
  it("records initial SDK setup and reused-session delivery as separate stages", async () => {
    const f = await setup(); const records = vi.fn();
    for (const n of [1, 2]) {
      const timing = createLocalTiming({ source: "main", conversationId: "c", turnId: `turn-${n}` }, records);
      const running = f.worker.run({ ...f.input, timing }, f.emit, new AbortController().signal, f.observer);
      await vi.waitFor(() => expect(f.received).toHaveLength(n));
      if (n == 1) f.push({ type: "system", subtype: "task_started", task_id: "background", description: "Fixture background task" });
      f.push(reply(f.received[n - 1]!.uuid, "PRIVATE_REPLY"));
      f.push(result(f.received[n - 1]!.uuid, "PRIVATE_REPLY")); await running;
    }
    const stages = (id: string) => records.mock.calls.map(([record]) => record).filter((r) => r.turnId === id).map((r) => r.stage);
    expect(stages("turn-1")).toEqual(expect.arrayContaining(["provider.lookup", "provider.config", "provider.sdk_ready", "provider.input_yielded", "provider.first_event", "provider.result"]));
    expect(stages("turn-2")).toEqual(expect.arrayContaining(["provider.refresh", "provider.input_yielded", "provider.first_event", "provider.result"]));
    expect(stages("turn-2")).not.toContain("provider.sdk_ready");
    expect(JSON.stringify(records.mock.calls)).not.toContain("PRIVATE_REPLY");
  });
  it("refreshes a background shell's output while it runs, without another model message", async () => {
    const f = await setup(); const first = await f.begin();
    const root = await mkdtemp(join(tmpdir(), "multica-live-output-"));
    cleanups.unshift(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "native-conversation", "tasks"); await mkdir(directory, { recursive: true });
    const path = join(directory, "shell.output"); await writeFile(path, "Installing dependencies\n");
    f.push({ type: "system", subtype: "task_started", task_id: "shell", tool_use_id: "call", task_type: "local_bash", is_backgrounded: false, description: "Install" });
    f.push({ type: "user", tool_use_result: { backgroundTaskId: "shell" }, message: { content: [{ type: "tool_result", tool_use_id: "unrelated-call", content: `Output is being written to: ${path}. You will be notified when it completes.` }] } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.observer.tasks.mock.calls.flatMap(([tasks]) => tasks)).toEqual([]);
    f.push({ type: "user", tool_use_result: { backgroundTaskId: "shell" }, message: { content: [{ type: "tool_result", tool_use_id: "call", content: `Command running in background with ID: shell. Output is being written to: ${path}. You will be notified when it completes.` }] } });
    f.push(reply(first.uuid, "Installing separately.")); await first.result;
    await vi.waitFor(() => expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ status: "running", output: "Installing dependencies\n" })]));
    await writeFile(path, "Installing dependencies\nDownloading browser 50%\n");
    await vi.waitFor(() => expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ status: "running", output: expect.stringContaining("Downloading browser 50%") })]), { timeout: 2000 });
    expect(f.received).toHaveLength(1); expect(f.create).toHaveBeenCalledOnce();
    f.push({ type: "system", subtype: "task_notification", task_id: "shell", status: "completed", summary: "Installed", output_file: path });
    await vi.waitFor(() => expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ status: "completed", output: expect.stringContaining("Downloading browser 50%") })]));
  });
  it("retains native progress and usage on the task's original turn while another reply runs", async () => {
    const f = await setup(); const first = await f.begin();
    f.push({ type: "system", subtype: "task_started", task_id: "monitor", tool_use_id: "shell", task_type: "local_bash", is_backgrounded: true, description: "Inspect releases" });
    f.push(reply(first.uuid, "Working separately.")); await first.result;
    const nextObserver = { tasks: vi.fn(), reply: vi.fn() };
    const next = f.worker.run({ ...f.input, content: "Continue" }, vi.fn(), new AbortController().signal, nextObserver);
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    f.push({ type: "system", subtype: "task_progress", task_id: "monitor", description: "Inspect releases", summary: "Reading the release assets", last_tool_name: "Bash", usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4200 } });
    await vi.waitFor(() => expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ id: "monitor", toolUseId: "shell", taskType: "local_bash", progressSummary: "Reading the release assets", lastToolName: "Bash", usage: { totalTokens: 1200, toolUses: 3, durationMs: 4200 } })]));
    expect(nextObserver.tasks).not.toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "monitor" })]));
    f.push(reply(f.received[1]!.uuid, "Continued.")); await next;
    f.push({ type: "system", subtype: "task_notification", task_id: "monitor", status: "completed", summary: "Finished" });
    f.push({ type: "system", subtype: "task_progress", task_id: "monitor", summary: "Late progress", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } });
    await vi.waitFor(() => expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ status: "completed", summary: "Finished", progressSummary: "Reading the release assets" })]));
  });
  it("keeps foreground shell bookends out of background cards and activity", async () => {
    const f = await setup(); const first = await f.begin();
    f.push({ type: "system", subtype: "task_started", task_id: "foreground-shell", is_backgrounded: false, description: "Inspect releases" });
    f.push({ type: "system", subtype: "task_notification", task_id: "foreground-shell", status: "completed", summary: "Inspect releases" });
    f.push(reply(first.uuid, "Done.")); f.push(result(first.uuid, "Done."));
    expect(await first.result).toMatchObject({ output: "Done." });
    expect(f.observer.tasks.mock.calls.flatMap(([tasks]) => tasks)).toEqual([]);
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
  });
  it("publishes a shell when a native update moves it to the background", async () => {
    const f = await setup(); const first = await f.begin();
    f.push({ type: "system", subtype: "task_started", task_id: "shell", tool_use_id: "call", is_backgrounded: false, description: "Build" });
    f.push({ type: "system", subtype: "task_updated", task_id: "shell", patch: { is_backgrounded: true } });
    f.push(reply(first.uuid, "Build continues."));
    expect(await first.result).toMatchObject({ output: "Build continues." });
    expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ id: "shell", status: "running", toolUseId: "call" })]);
    expect(f.transport.close).not.toHaveBeenCalled();
  });
  it("reads a completed background command's bounded output instead of repeating its description", async () => {
    const f = await setup(); const first = await f.begin();
    const root = await mkdtemp(join(tmpdir(), "multica-task-output-"));
    cleanups.unshift(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "task.output"); await writeFile(path, "v2.1.0\nnode v24\n");
    f.push({ type: "system", subtype: "task_started", task_id: "shell", description: "Inspect releases", task_type: "local_bash", is_backgrounded: true });
    f.push(reply(first.uuid, "Checking.")); await first.result;
    f.push({ type: "system", subtype: "task_notification", task_id: "shell", status: "completed", summary: "Inspect releases", output_file: path, usage: { total_tokens: 0, tool_uses: 1, duration_ms: 500 } });
    await vi.waitFor(() => expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ status: "completed", output: "v2.1.0\nnode v24\n", usage: { totalTokens: 0, toolUses: 1, durationMs: 500 }, completedAt: expect.any(String) })]));
  });
  it("delivers image paths as text on both initial and follow-up messages", async () => {
    const f = await setup();
    const path = "/test-owned/image with spaces.png";
    for (const content of ["Describe the image", "Compare this image"]) {
      const pending = f.worker.run({ ...f.input, content: `${content} at ${JSON.stringify(path)}` }, f.emit, new AbortController().signal, f.observer);
      await vi.waitFor(() => expect(f.received).toHaveLength(content === "Describe the image" ? 1 : 2));
      const message = f.received.at(-1)!;
      expect(message.message.content).toBe(`${content} at ${JSON.stringify(path)}`);
      f.push({ type: "system", subtype: "task_started", task_id: "owned-background", description: "Keep the test transport open" });
      f.push(reply(message.uuid, "Image received"));
      await pending;
    }
    expect(f.create).toHaveBeenCalledOnce();
  });
  it.skipIf(process.platform === "win32")("uses the actual SDK duplex transport with a test-owned CLI and never needs process exit to continue", async () => {
    const root = await mkdtemp(join(tmpdir(), "multica-claude-duplex-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, "fake-claude");
    await writeFile(binary, `#!/usr/bin/env node
const {randomUUID} = require('node:crypto');
const session = randomUUID(); let first;
const emit = value => process.stdout.write(JSON.stringify({uuid:randomUUID(),session_id:session,...value})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const input = JSON.parse(line);
  if (input.type === 'control_request') {
    emit({type:'control_response',response:{subtype:'success',request_id:input.request_id,response:{commands:[],models:[],output_style:'default',available_output_styles:[],added:[],removed:[],errors:{}}}});
  } else if (input.type === 'user') {
    emit({type:'system',subtype:'init'});
    if (!first) {
      first = input.uuid;
      emit({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'monitor',description:'Test-owned watcher',task_type:'local_bash'}]});
      emit({type:'assistant',user_message_uuid:first,message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'First reply; watcher remains alive.'}]}});
    } else {
      emit({type:'result',subtype:'success',is_error:false,user_message_uuid:first,result:'First reply; watcher remains alive.'});
      emit({type:'assistant',user_message_uuid:input.uuid,message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'Second reply in the same process.'}]}});
      emit({type:'system',subtype:'task_notification',task_id:'monitor',status:'completed',summary:'Test watcher finished'});
      emit({type:'system',subtype:'background_tasks_changed',tasks:[]});
      emit({type:'assistant',user_message_uuid:first,message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'Watcher finished.'}]}});
      emit({type:'result',subtype:'success',is_error:false,user_message_uuid:input.uuid,result:'Second reply in the same process.'});
    }
  }
});
`, { mode: 0o700 });
    const dispose = vi.fn(async () => {});
    const worker = new LocalClaudeConversation(dispose, { find: async () => binary, query: async (prompt, options) => (await import("@anthropic-ai/claude-agent-sdk")).query({ prompt, options }), pluginSettings: readClaudePluginSettings });
    cleanups.push(() => worker.stop());
    const input = { provider: "claude" as const, cwd: root, content: "Fake first message", env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: root } };
    const observer = { tasks: vi.fn(), reply: vi.fn() };
    expect(await worker.run(input, vi.fn(), new AbortController().signal, observer)).toMatchObject({ output: "First reply; watcher remains alive." });
    expect(worker.available).toBe(true);
    expect(await worker.run({ ...input, content: "Fake second message" }, vi.fn(), new AbortController().signal, observer)).toMatchObject({ output: "Second reply in the same process." });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(observer.reply).toHaveBeenCalledExactlyOnceWith("Watcher finished.", ["monitor"]);
  });
  it("finishes the reply while a background monitor keeps the CLI alive, then accepts another message in that same process", async () => {
    const f = await setup(); const first = await f.begin();
    f.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "monitor", description: "Wait for PR to merge", task_type: "local_bash" }] });
    await vi.waitFor(() => expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ id: "monitor", status: "running", createdAt: expect.any(String) })]));
    const createdAt = f.observer.tasks.mock.calls.at(-1)![0][0]!.createdAt;
    f.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "monitor", description: "Wait for PR to merge", task_type: "local_bash" }] });
    f.push(reply(first.uuid, "PR created. Monitoring in the background."));
    expect(await first.result).toEqual({ output: "PR created. Monitoring in the background.", sessionId: "native-conversation" });
    expect(f.transport.close).not.toHaveBeenCalled();
    expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ id: "monitor", status: "running", createdAt })]);
    const nextObserver = { tasks: vi.fn(), reply: vi.fn() };
    const next = f.worker.run({ ...f.input, content: "Continue the conversation" }, vi.fn(), new AbortController().signal, nextObserver);
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    expect(f.create).toHaveBeenCalledOnce();
    // A held-back result for the previous prompt must not finish the next prompt.
    f.push(result(first.uuid, "Old reply"));
    const finished = vi.fn(); void next.then(finished);
    await new Promise((resolve) => setImmediate(resolve)); expect(finished).not.toHaveBeenCalled();
    f.push(reply(f.received[1]!.uuid, "Following up without losing the monitor."));
    expect(await next).toMatchObject({ output: "Following up without losing the monitor." });
    expect(nextObserver.tasks).not.toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "monitor" })]));
    expect(f.transport.close).not.toHaveBeenCalled();
  });
  it("handles a late background membership snapshot and delivers its completion reply to the original turn", async () => {
    const f = await setup(); const first = await f.begin();
    f.push(reply(first.uuid, "I will monitor it."));
    f.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "monitor", description: "Wait for PR" }] });
    await first.result;
    f.push({ type: "system", subtype: "task_notification", task_id: "monitor", status: "completed", summary: "PR merged" });
    f.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    f.push(reply(first.uuid, "The PR is now merged."));
    f.push(result(first.uuid, "The PR is now merged."));
    await vi.waitFor(() => expect(f.observer.reply).toHaveBeenCalledExactlyOnceWith("The PR is now merged.", ["monitor"]));
    expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ status: "completed", summary: "PR merged" })]);
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
  });
  it("recognizes streamed end_turn deltas when assembled assistant frames have no stop reason", async () => {
    const f = await setup(); const first = await f.begin();
    f.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "monitor", description: "Wait" }] });
    f.push({ type: "stream_event", user_message_uuid: first.uuid, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Monitoring in background." } } });
    f.push({ ...reply(first.uuid, "Monitoring in background."), message: { stop_reason: null, content: [{ type: "text", text: "Monitoring in background." }] } });
    f.push({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } });
    expect(await first.result).toMatchObject({ output: "Monitoring in background." });
    expect(f.transport.close).not.toHaveBeenCalled();
    f.push({ type: "system", subtype: "task_notification", task_id: "monitor", status: "completed", summary: "Done" });
    f.push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Background result delivered." } } });
    f.push({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } });
    await vi.waitFor(() => expect(f.observer.reply).toHaveBeenCalledExactlyOnceWith("Background result delivered.", ["monitor"]));
  });
  it("settles missed task notifications from the authoritative membership snapshot", async () => {
    const f = await setup(); const first = await f.begin();
    f.push({ type: "system", subtype: "task_started", task_id: "monitor", description: "Wait for PR" });
    f.push(reply(first.uuid, "Monitoring.")); await first.result;
    f.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    f.push(result(first.uuid, "Monitoring."));
    await vi.waitFor(() => expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ status: "completed" })]));
    expect(f.transport.close).not.toHaveBeenCalled();
    expect(f.worker.claimDelivery(["monitor"], "followup")).toBe(true);
  });
  it("does not resurrect a finished monitor from a late task-start bookend", async () => {
    const f = await setup(); const first = await f.begin();
    f.push({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "monitor", description: "Wait" }] });
    f.push(reply(first.uuid, "Watching.")); await first.result;
    f.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    f.push({ type: "system", subtype: "task_started", task_id: "monitor", description: "Late start" });
    f.push(result(first.uuid, "Watching."));
    await vi.waitFor(() => expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ status: "completed" })]));
    expect(f.transport.close).not.toHaveBeenCalled();
    expect(f.worker.claimDelivery(["monitor"], "followup")).toBe(true);
  });
  it("stops the monitor without cancelling an unrelated foreground reply", async () => {
    const f = await setup(); const first = await f.begin();
    f.push({ type: "system", subtype: "task_started", task_id: "monitor", description: "Wait" });
    f.push(reply(first.uuid, "Watching.")); await first.result;
    const next = f.worker.run({ ...f.input, content: "Keep working" }, vi.fn(), new AbortController().signal, { tasks: vi.fn(), reply: vi.fn() });
    const finished = vi.fn(); void next.then(finished);
    await vi.waitFor(() => expect(f.received).toHaveLength(2)); await f.worker.stopBackground();
    expect(f.transport.stopTask).toHaveBeenCalledWith("monitor");
    expect(finished).not.toHaveBeenCalled(); expect(f.transport.close).not.toHaveBeenCalled();
    f.push(reply(f.received[1]!.uuid, "Foreground work survived.")); f.push(result(f.received[1]!.uuid, "Foreground work survived."));
    expect(await next).toMatchObject({ output: "Foreground work survived." });
  });
  it("keeps foreground tools and human questions pending until a real reply boundary", async () => {
    const f = await setup(); const first = await f.begin(); const finished = vi.fn(); void first.result.then(finished);
    f.push({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "question", name: `mcp__${CONTEXT_MCP_NAME}__ask_user_question`, input: {} }] } });
    await new Promise((resolve) => setImmediate(resolve)); expect(finished).not.toHaveBeenCalled();
    f.push(reply(first.uuid, "Thanks for your answer.")); f.push(result(first.uuid, "Thanks for your answer."));
    expect(await first.result).toMatchObject({ output: "Thanks for your answer." });
    expect(f.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "tool_use" }));
  });
  it("refreshes scoped MCP context, model and explicit permissions before sending the next message", async () => {
    const f = await setup(); const first = await f.begin();
    f.push({ type: "system", subtype: "task_started", task_id: "monitor", description: "Wait" });
    f.push(reply(first.uuid, "Watching.")); await first.result;
    const root = await mkdtemp(join(tmpdir(), "multica-claude-stream-")); cleanups.unshift(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "mcp.json"); const server = { type: "http", url: "http://127.0.0.1:12345/current-context", headers: { Authorization: "Bearer test-only" } };
    await writeFile(path, JSON.stringify({ mcpServers: { [CONTEXT_MCP_NAME]: server } }));
    const next = f.worker.run({ ...f.input, content: "Use this message's context", model: "sonnet", permissionMode: "auto", mcp: { url: server.url, claudeConfigPath: path } }, vi.fn(), new AbortController().signal, { tasks: vi.fn(), reply: vi.fn() });
    await vi.waitFor(() => expect(f.received).toHaveLength(2));
    expect(f.transport.setMcpServers).toHaveBeenCalledWith({ [CONTEXT_MCP_NAME]: server });
    expect(f.transport.setModel).toHaveBeenCalledWith("sonnet"); expect(f.transport.setPermissionMode).toHaveBeenCalledWith("auto");
    expect(f.create.mock.calls[0]?.[1]).toMatchObject({ pathToClaudeCodeExecutable: "/test-owned/fake-claude", systemPrompt: { type: "preset", preset: "claude_code", append: "Existing Multica rules", snapshot: false }, settingSources: ["user", "project", "local"], plugins: [], strictMcpConfig: true, settings: { enabledPlugins: { "fixture@market": false }, syncClaudeAiPlugins: false } });
    f.push(reply(f.received[1]!.uuid, "Updated context used.")); await next;
  });
  it("cancels a live foreground request and cleans up background tasks and retained context", async () => {
    const f = await setup(); const abort = new AbortController();
    const pending = f.worker.run(f.input, f.emit, abort.signal, f.observer);
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.push({ type: "system", subtype: "task_started", task_id: "monitor", description: "Wait" });
    await vi.waitFor(() => expect(f.observer.tasks).toHaveBeenCalled()); abort.abort();
    await expect(pending).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
    expect(f.observer.tasks).toHaveBeenLastCalledWith([expect.objectContaining({ status: "cancelled" })]);
  });
});
