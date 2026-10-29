// @vitest-environment node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMulticaContext, type LocalExecutionContext } from "./local-multica-context";
import { LocalConversationService } from "./local-conversation-service";
import { CONTEXT_MCP_NAME, CONTEXT_MCP_TOKEN_ENV, CONTEXT_MCP_TOOLS } from "./local-context-mcp";
import { runLocalProvider } from "./local-provider-runner";
import { CREATE_TASK_MENTION_ID } from "@multica/core/local-conversation/protocol";
import { DeveloperLogExporter, createDeveloperLogTool } from "../main/developer-log-export";
import { WebDiagnosticLog, snapshotDaemonLog } from "../main/developer-runtime-logs";
import { LocalTimingLog } from "../main/local-timing-log";
import { createLocalTiming } from "@multica/tutti-agent-gui-host/local-timing";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const scope = { userId: "user", workspaceId: "workspace" };
const textResult = (value: unknown) => {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) throw new Error("Expected MCP content");
  const block = value.content.find((entry) => entry.type === "text");
  if (!block || typeof block.text !== "string") throw new Error("Expected MCP text");
  return JSON.parse(block.text);
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "multica-mcp-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const requests: string[] = [];
  const creations: { title: string; description?: string }[] = [];
  let slowClosed = false;
  const api = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== "Bearer test-cloud-token" || (request.url !== "/api/me" && request.headers["x-workspace-id"] !== "workspace")) { response.writeHead(403).end(); return; }
    response.setHeader("content-type", "application/json");
    const path = new URL(request.url!, "http://localhost");
    let data: unknown;
    if (request.method === "POST" && path.pathname === "/api/issues") {
      let content = ""; for await (const chunk of request) content += chunk;
      const input = JSON.parse(content); creations.push(input);
      if (input.title === "Denied") { response.writeHead(403).end(); return; }
      data = input.title === "Malformed" ? { workspace_id: "workspace" } : { id: `created-${creations.length}`, identifier: `TES-${900 + creations.length}`, title: input.title, workspace_id: input.title === "Foreign" ? "other" : "workspace", status: "backlog", private_metadata: "do-not-return" };
    }
    else if (path.pathname === "/api/me") data = { id: "user" };
    else if (path.pathname === "/api/agents/reviewer") data = { id: "reviewer", workspace_id: "workspace", name: "Code reviewer", instructions: "Review implementation quality", custom_env: { API_KEY: "never-leak" }, mcp_config: { token: "never-leak" }, system_instructions: "private" };
    else if (path.pathname === "/api/agents/foreign") data = { id: "foreign", workspace_id: "other" };
    else if (path.pathname === "/api/agents/slow") { response.on("close", () => { slowClosed = true; }); return; }
    else if (path.pathname === "/api/agents") data = [{ id: "reviewer", workspace_id: "workspace", name: "Code reviewer" }];
    else if (path.pathname === "/api/chat/sessions") data = [{ id: "cloud-chat", workspace_id: "workspace", title: "Official chat" }];
    else if (path.pathname === "/api/chat/sessions/cloud-chat") data = { id: "cloud-chat", workspace_id: "workspace", title: "Official chat" };
    else if (path.pathname === "/api/chat/sessions/cloud-chat/messages/page") data = path.searchParams.has("before_id") ? { messages: [{ id: "older", content: "Older official reply" }], has_more: false } : { messages: [{ id: "newer", content: "Latest official reply" }], has_more: true, next_cursor: { id: "newer", created_at: "2026-10-24T18:00:00Z" } };
    else if (path.pathname === "/api/attachments/cloud-file") data = { id: "cloud-file", workspace_id: "workspace", content_type: "image/png", filename: "image.png" };
    else if (path.pathname === "/api/issues/task") {
      const earlier = path.searchParams.has("before");
      data = { issue: { id: "task", workspace_id: "workspace", title: "Task context", description: "FULL_DESCRIPTION_" + "x".repeat(7000) }, comments: [{ body: earlier ? "Earlier full thread" : "Latest full thread" }], comments_page: { has_more: !earlier, next_before: "2026-10-24", next_before_id: "comment", truncated: false } };
    } else { response.writeHead(404).end(); return; }
    response.end(JSON.stringify(data));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { api.closeAllConnections(); api.close(() => resolve()); }));
  const apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const cliPath = join(root, "fake-multica");
  await writeFile(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.env.MULTICA_TASK_CONFIG_ROOT + '/config.json', 'utf8'));
const args = process.argv.slice(2);
if (args.includes('attachment')) {
  const folder = args[args.indexOf('-o') + 1]; fs.mkdirSync(folder,{recursive:true});
  const path = folder + '/image.png'; fs.writeFileSync(path,'image'); console.log(JSON.stringify({id:'cloud-file',path}));
} else {
  const cursor = args.includes('--before') ? '?before=older' : '';
  fetch(config.server_url + '/api/issues/task' + cursor, {headers:{Authorization:'Bearer '+config.token,'X-Workspace-ID':config.workspace_id}}).then(r=>r.json()).then(data=>console.log(JSON.stringify(data)));
}
`, { mode: 0o700 });
  const prepared: LocalExecutionContext[] = [];
  const options = {
    root: join(root, "contexts"), apiUrl, cliPath,
    readProfile: vi.fn(async () => ({ userId: "user", token: "test-cloud-token", serverUrl: apiUrl })),
    local: (current: typeof scope) => ({ list: () => service.request(current, "list", {}), read: (id: string) => service.request(current, "read", { id }), file: (id: string) => service.request(current, "fileRead", { id }) }),
  };
  const context = new LocalMulticaContext(options);
  const service: LocalConversationService = new LocalConversationService({ root: join(root, "conversations"), apiUrl, find: async () => cliPath, chooseDirectory: async () => null, notify: () => {},
    prepareContext: async (scope, signal, current) => { const run = await context.prepare(scope, signal, current); prepared.push(run); return run; },
    usage: { read: vi.fn(), reset: vi.fn() }, run: vi.fn(async () => ({ output: "unused" })),
  });
  service.setCurrentUser("user"); cleanups.push(() => service.stop());
  const source = await service.request(scope, "create", { provider: "codex", title: "Saved context" });
  for (let index = 0; index < 12; index++) {
    const remote = await service.request(scope, "remoteBegin", { id: source.id, content: index === 0 ? "ORIGINAL_HISTORY_MARKER" : `Question ${index}`, agents: [{ id: "reviewer", name: "Code reviewer" }] });
    await service.request(scope, "remoteUpdate", { id: source.id, turnId: remote.turns[0]!.id, status: "completed", output: index === 0 ? "L".repeat(13000) : `Result ${index}`,
      events: [{ seq: 1, type: "thinking", content: "internal-only", created_at: source.createdAt }, { seq: 2, type: "tool_result", tool: "Read", output: "SAVED_TOOL_RESULT", created_at: source.createdAt }] });
  }
  const controller = new AbortController();
  const run = await context.prepare(scope, controller.signal, { conversationId: source.id, references: [{ kind: "issue", id: "task" }, { kind: "session", id: source.id }] });
  cleanups.push(() => run.dispose());
  const client = new Client({ name: "context-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(run.mcp!.url), { requestInit: { headers: { Authorization: `Bearer ${run.env[CONTEXT_MCP_TOKEN_ENV]}` } } }));
  cleanups.push(() => client.close());
  return { root, options, apiUrl, requests, creations, service, source, context, controller, run, client, prepared, slowClosed: () => slowClosed };
}

async function actionClient(context: LocalMulticaContext, conversationId: string) {
  const run = await context.prepare(scope, new AbortController().signal, { conversationId, references: [{ kind: "issue", id: CREATE_TASK_MENTION_ID }] });
  cleanups.push(() => run.dispose());
  const client = new Client({ name: "task-creation-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(run.mcp!.url), { requestInit: { headers: { Authorization: `Bearer ${run.env[CONTEXT_MCP_TOKEN_ENV]}` } } }));
  cleanups.push(() => client.close());
  return { client, run };
}

describe("built-in Multica context MCP", () => {
  it("registers developer log export and advertises it to both providers without cloud login", async () => {
    const data = await fixture();
    const log = new LocalTimingLog(join(data.root, "diagnostics"));
    createLocalTiming({ source: "main", conversationId: data.source.id, provider: "codex" }, log.write).mark("provider.first_text");
    const web = new WebDiagnosticLog(join(data.root, "diagnostics"), "https://test.invalid", scope.userId);
    web.console({ level: "warning", message: "Web transport retry" });
    const daemonPath = join(data.root, "daemon.log");
    await writeFile(daemonPath, "12:34:56.789 INF daemon connected\n");
    const exporter = new DeveloperLogExporter({
      log,
      runtimeLogs: async (_scope, since, until) => ({ web: await web.snapshot(since, until), daemon: await snapshotDaemonLog(daemonPath) }),
      exportsRoot: join(data.root, "exports"),
      runtime: { appVersion: "test", platform: "test", arch: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: "test", packaged: false },
      assertScope: (scope) => data.service.assertScope(scope),
      conversations: async (scope) => (await data.service.request(scope, "list", {})).map((entry) => entry.id),
      chooseSavePath: async () => null,
    });
    const context = new LocalMulticaContext({ ...data.options, readProfile: async () => { throw new Error("offline"); }, developerLogTool: (scope, id) => createDeveloperLogTool(exporter, scope, id) });
    const { client, run } = await actionClient(context, data.source.id);
    expect(run.mcp?.tools).toContain("export_developer_logs");
    expect(run.systemPrompt).toContain("use export_developer_logs");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("export_developer_logs");
    const result = textResult(await client.callTool({ name: "export_developer_logs", arguments: { request_id: "diagnose" } }));
    expect(result).toMatchObject({ format: "json", recordCount: 3, timingRecordCount: 1, webRecordCount: 1, daemonLineCount: 1, filter: { conversationId: data.source.id } });
    const bundle = JSON.parse(await readFile(result.path, "utf8"));
    expect(bundle.records[0].stage).toBe("provider.first_text");
    expect(bundle.sources.web.records[0].message).toBe("Web transport retry");
    expect(bundle.sources.daemon.text).toContain("daemon connected");
    const denied = await client.callTool({ name: "export_developer_logs", arguments: { request_id: "foreign", conversation_id: "foreign" } });
    expect(denied.isError).toBe(true);
  });
  it("exposes task creation only for the current New task mention and returns a scoped server result", async () => {
    const data = await fixture();
    expect((await data.client.listTools()).tools.map((tool) => tool.name)).not.toContain("create_task");
    const { client, run } = await actionClient(data.context, data.source.id);
    expect((await client.listTools()).tools.find((tool) => tool.name === "create_task")?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(run.mcp?.tools).toContain("create_task");
    expect(run.systemPrompt).toContain("not an existing task ID");
    expect(run.systemPrompt).toContain("Return the identifier as a link");
    expect(textResult(await client.callTool({ name: "current_context", arguments: {} }))).toMatchObject({ actions: ["create_task"], references: [] });
    expect(data.creations).toHaveLength(0);
    const input = { title: "Create acceptance tests", description: "Cover keyboard navigation", request_id: "acceptance-task" };
    const [first, second] = await Promise.all([client.callTool({ name: "create_task", arguments: input }), client.callTool({ name: "create_task", arguments: input })]);
    expect(textResult(first)).toEqual(textResult(second));
    expect(textResult(first)).toMatchObject({ id: "created-1", identifier: "TES-901", workspace_id: "workspace", href: "mention://issue/created-1" });
    expect(JSON.stringify(first)).not.toContain("do-not-return");
    expect(data.creations).toEqual([{ title: input.title, description: input.description }]);
    expect((await client.callTool({ name: "create_task", arguments: { ...input, title: "Different content" } })).isError).toBe(true);
    expect(data.creations).toHaveLength(1);
    const following = await data.context.prepare(scope, new AbortController().signal, { conversationId: data.source.id, references: [] });
    cleanups.push(() => following.dispose());
    expect(following.mcp?.tools).not.toContain("create_task");
  });
  it("does not register a write tool without verified desktop cloud credentials", async () => {
    const data = await fixture();
    data.options.readProfile.mockRejectedValue(new Error("Not signed in"));
    const { client, run } = await actionClient(data.context, data.source.id);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(CONTEXT_MCP_TOOLS);
    expect(run.systemPrompt).toContain("Task creation is unavailable");
    expect(data.creations).toHaveLength(0);
  });
  it.each(["Denied", "Malformed", "Foreign"])("reports %s creation as an error and keeps its request key from creating again", async (title) => {
    const data = await fixture();
    const { client } = await actionClient(data.context, data.source.id);
    const input = { title, request_id: "same-create-request" };
    expect((await client.callTool({ name: "create_task", arguments: input })).isError).toBe(true);
    expect((await client.callTool({ name: "create_task", arguments: input })).isError).toBe(true);
    expect(data.creations).toHaveLength(1);
  });
  it("finds and reads a copied conversation ID without an @ reference or cloud login", async () => {
    const { service, source, options, context } = await fixture();
    await service.request(scope, "update", { id: source.id, title: "Renamed conversation", archived: true });
    const active = await service.request(scope, "create", { provider: "claude", title: "Current conversation" });
    options.readProfile.mockRejectedValue(new Error("Cloud login unavailable"));
    const run = await context.prepare(scope, new AbortController().signal, { conversationId: active.id, references: [] });
    cleanups.push(() => run.dispose());
    const client = new Client({ name: "copied-id-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(run.mcp!.url), { requestInit: { headers: { Authorization: `Bearer ${run.env[CONTEXT_MCP_TOKEN_ENV]}` } } }));
    cleanups.push(() => client.close());
    expect(textResult(await client.callTool({ name: "current_context", arguments: {} }))).toMatchObject({ conversation_id: active.id, references: [] });
    const found = textResult(await client.callTool({ name: "search_context", arguments: { kind: "conversation", query: source.id } }));
    expect(found.results).toEqual([expect.objectContaining({ id: source.id, title: "Renamed conversation", archived: true })]);
    const history = textResult(await client.callTool({ name: "read_context", arguments: { kind: "conversation", id: source.id, source: "local", limit: 50 } }));
    expect(history.conversation).toMatchObject({ id: source.id, title: "Renamed conversation", archived: true });
    expect(history.messages).toHaveLength(24);
    expect(history.messages[0].content).toBe("ORIGINAL_HISTORY_MARKER");
    expect(history.has_more).toBe(false);
    expect(run.systemPrompt).toContain("id=<copied-conversation-id>");
  });
  it("aborts in-flight context reads before removing the execution's private directory on normal disposal", async () => {
    const { client, run, requests, slowClosed } = await fixture();
    const pending = client.callTool({ name: "read_context", arguments: { kind: "agent", id: "slow" } }).catch(() => null);
    await vi.waitFor(() => expect(requests).toContain("GET /api/agents/slow"));
    await run.dispose();
    await pending;
    await vi.waitFor(() => expect(slowClosed()).toBe(true));
    await expect(stat(run.env.MULTICA_TASK_CONFIG_ROOT!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.skipIf(process.platform === "win32").each(["codex", "claude"] as const)("registers context tools for new and resumed %s executions and returns retrieved data over the provider stream", async (provider) => {
    const { root, context, source, creations } = await fixture();
    const executable = join(root, "fake-provider");
    await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('app-server')) {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const req = JSON.parse(line);
    if (req.id) console.log(JSON.stringify({id:req.id,result:req.method==='config/read'?{config:{developer_instructions:'Existing user instructions'}}:{}}));
  });
} else {
let input=''; process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',async()=>{
  let url,headers;
  if (args.includes('--mcp-config')) {
    const cfg=JSON.parse(require('node:fs').readFileSync(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers.multica_desktop_context;
    url=cfg.url; headers=cfg.headers;
    if (!args[args.indexOf('--allowedTools')+1].includes('mcp__multica_desktop_context__read_context')) throw new Error('Missing read permission');
  } else {
    const cfg=args.find(value=>value.startsWith('mcp_servers.multica_desktop_context='));
    url=JSON.parse(cfg.match(/url=("[^"]+")/)[1]); headers={Authorization:'Bearer '+process.env.MULTICA_CONTEXT_MCP_TOKEN};
  }
  let id=0;
  const call=async(method,params)=>{
    const response=await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
    const reply=await response.json(); if(reply.error) throw new Error(reply.error.message); return reply.result;
  };
  await call('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fake-native',version:'1'}});
  const tool=async(name,arguments)=>{
    const reply=await call('tools/call',{name,arguments}); if(reply.isError)throw new Error(reply.content[0].text); return JSON.parse(reply.content[0].text);
  };
  const current=await tool('current_context',{});
  if(current.actions?.includes('create_task') && args.includes('--mcp-config') && !args[args.indexOf('--allowedTools')+1].includes('mcp__multica_desktop_context__create_task')) throw new Error('Missing task creation permission');
  let cursor,first;
  do {const page=await tool('read_context',{kind:'conversation',id:current.conversation_id,limit:5,...(cursor?{cursor}:{})});first=page.messages[0]?.content;cursor=page.next_cursor;} while(cursor);
  const task=await tool('read_context',{kind:'task',id:'task'});
  const agent=await tool('read_context',{kind:'agent',id:'reviewer'});
  const created=current.actions?.includes('create_task') ? await tool('create_task',{title:'Agent-created review task',description:'Use retrieved context',request_id:'review-task'}) : undefined;
  const output=JSON.stringify({first,task:task.comments[0].body,agent:agent.agent.name,resumed:args.includes('--resume')||args.includes('resume'),created:created?.identifier});
  if(args[0]==='exec') {
    console.log(JSON.stringify({type:'thread.started',thread_id:'fake-native-session'}));
    console.log(JSON.stringify({type:'item.started',item:{id:'mcp-call',type:'mcp_tool_call',server:'multica_desktop_context',tool:'read_context',arguments:{id:current.conversation_id}}}));
    console.log(JSON.stringify({type:'item.completed',item:{id:'mcp-call',type:'mcp_tool_call',server:'multica_desktop_context',tool:'read_context',result:{content:[{type:'text',text:output}]}}}));
    console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:output}}));
  } else console.log(JSON.stringify({type:'result',session_id:'fake-native-session',is_error:false,result:output}));
});
}
`, { mode: 0o700 });
    for (const create of [false, true]) for (const resume of [undefined, "fake-native-session"]) {
      const controller = new AbortController();
      const run = await context.prepare(scope, controller.signal, { conversationId: source.id, references: create ? [{ kind: "issue", id: CREATE_TASK_MENTION_ID }] : [] });
      try {
        const events: unknown[] = [];
        const result = await runLocalProvider({ provider, cwd: root, content: "Read the referenced context", systemPrompt: run.systemPrompt, env: { ...run.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, "test-claude-config") }, mcp: run.mcp, resume }, (event) => events.push(event), controller.signal, executable);
        expect(JSON.parse(result.output)).toEqual({ first: "ORIGINAL_HISTORY_MARKER", task: "Latest full thread", agent: "Code reviewer", resumed: Boolean(resume), ...(create ? { created: expect.stringMatching(/^TES-\d+$/) } : {}) });
        if (provider === "codex") expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", tool: `mcp__${CONTEXT_MCP_NAME}__read_context` }));
      } finally { await run.dispose(); }
    }
    expect(creations).toHaveLength(2);
  }, 30_000);

  it("serves complete paged local history, long messages, tool results and native image data through actual MCP requests", async () => {
    const { client, source, service } = await fixture();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(CONTEXT_MCP_TOOLS);
    expect((await client.listTools()).tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    const current = textResult(await client.callTool({ name: "current_context", arguments: {} }));
    expect(current).toMatchObject({ workspace_id: "workspace", conversation_id: source.id, references: [{ kind: "issue", id: "task" }, { kind: "session", id: source.id }] });
    const messages: { id: string; content: string; content_truncated: boolean; turn_id: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = textResult(await client.callTool({ name: "read_context", arguments: { kind: "conversation", id: source.id, limit: 5, ...(cursor ? { cursor } : {}) } }));
      messages.unshift(...page.messages); cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(messages).toHaveLength(24); expect(new Set(messages.map((message) => message.id)).size).toBe(24);
    expect(messages[0].content).toBe("ORIGINAL_HISTORY_MARKER"); expect(messages[1].content_truncated).toBe(true);
    expect(textResult(await client.callTool({ name: "read_message", arguments: { conversation_id: source.id, message_id: messages[1].id, offset: 8000 } })).content).toHaveLength(5000);
    const execution = textResult(await client.callTool({ name: "read_execution", arguments: { conversation_id: source.id, turn_id: messages[0].turn_id } }));
    expect(execution.events).toHaveLength(1); expect(execution.events[0].output).toBe("SAVED_TOOL_RESULT");
    const file = await service.request(scope, "fileStore", { name: "pixel.png", mimeType: "image/png", data: Buffer.from("image-content").toString("base64") });
    const image = await client.callTool({ name: "read_attachment", arguments: file });
    expect(image.content).toContainEqual({ type: "image", data: Buffer.from("image-content").toString("base64"), mimeType: "image/png" });
  });

  it.skipIf(process.platform === "win32")("uses official read APIs and isolated CLI credentials for task discussions, cloud history and agent definitions", async () => {
    const { client, requests, run } = await fixture();
    const task = textResult(await client.callTool({ name: "read_context", arguments: { kind: "task", id: "task" } }));
    expect(task.issue.description.length).toBeGreaterThan(7000); expect(task.comments[0].body).toBe("Latest full thread");
    const older = textResult(await client.callTool({ name: "read_context", arguments: { kind: "task", id: "task", source: "cloud", cursor: task.next_cursor } }));
    expect(older.comments[0].body).toBe("Earlier full thread"); expect(older.next_cursor).toBeNull();
    const agent = textResult(await client.callTool({ name: "read_context", arguments: { kind: "agent", id: "reviewer" } }));
    expect(agent.agent.instructions).toBe("Review implementation quality"); expect(JSON.stringify(agent)).not.toContain("never-leak"); expect(agent.agent.system_instructions).toBeUndefined();
    const chat = textResult(await client.callTool({ name: "read_context", arguments: { kind: "conversation", id: "cloud-chat", source: "cloud" } }));
    const found = textResult(await client.callTool({ name: "search_context", arguments: { kind: "conversation", source: "cloud", query: "cloud-chat" } }));
    expect(found.results).toEqual([{ id: "cloud-chat", title: "Official chat" }]);
    const previous = textResult(await client.callTool({ name: "read_context", arguments: { kind: "conversation", id: "cloud-chat", source: "cloud", cursor: chat.next_cursor } }));
    expect(previous.messages[0].content).toBe("Older official reply");
    expect(requests).toContain("GET /api/chat/sessions/cloud-chat/messages/page?limit=10&before_created_at=2026-10-24T18%3A00%3A00Z&before_id=newer");
    const attachment = await client.callTool({ name: "read_attachment", arguments: { source: "cloud", id: "cloud-file" } });
    const download = textResult(attachment);
    expect(attachment.content).toContainEqual({ type: "image", data: Buffer.from("image").toString("base64"), mimeType: "image/png" });
    expect(await readFile(download.path, "utf8")).toBe("image");
    expect(download.path.startsWith(run.env.MULTICA_TASK_CONFIG_ROOT!)).toBe(true);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
  });

  it("rejects unauthenticated/browser/cross-workspace access, invalid cursors and ended executions", async () => {
    const { client, run, source, service, controller } = await fixture();
    expect((await fetch(run.mcp!.url, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(run.mcp!.url, { method: "POST", headers: { Authorization: `Bearer ${run.env[CONTEXT_MCP_TOKEN_ENV]}`, Origin: "https://untrusted.test" }, body: "{}" })).status).toBe(403);
    expect((await client.callTool({ name: "read_context", arguments: { kind: "agent", id: "foreign" } })).isError).toBe(true);
    expect((await client.callTool({ name: "read_context", arguments: { kind: "task", id: "--help" } })).isError).toBe(true);
    const first = textResult(await client.callTool({ name: "read_context", arguments: { kind: "conversation", id: source.id, limit: 1 } }));
    expect((await client.callTool({ name: "read_context", arguments: { kind: "conversation", id: "foreign", cursor: first.next_cursor } })).isError).toBe(true);
    const foreign = await service.request({ ...scope, workspaceId: "other" }, "create", { provider: "codex" });
    expect((await client.callTool({ name: "read_context", arguments: { kind: "conversation", id: foreign.id } })).isError).toBe(true);
    service.setCurrentUser("other-user");
    expect((await client.callTool({ name: "read_context", arguments: { kind: "conversation", id: source.id } })).isError).toBe(true);
    controller.abort(); await run.dispose();
    await expect(fetch(run.mcp!.url)).rejects.toThrow();
    await expect(stat(run.env.MULTICA_TASK_CONFIG_ROOT!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps credentials out of metadata, prompts and saved history", async () => {
    const { client, run, root, service } = await fixture();
    const metadata = JSON.stringify(await client.listTools()) + JSON.stringify(await client.callTool({ name: "current_context", arguments: {} }));
    for (const secret of ["test-cloud-token", run.env[CONTEXT_MCP_TOKEN_ENV]!]) {
      expect(metadata).not.toContain(secret); expect(run.systemPrompt).not.toContain(secret);
      await service.flush();
      const key = createHash("sha256").update(JSON.stringify([run.env.MULTICA_SERVER_URL, "user", "workspace"])).digest("hex");
      const dir = join(root, "conversations", key);
      const index = await readFile(join(dir, "index.json"), "utf8");
      expect(index).not.toContain(secret);
      for (const item of JSON.parse(index).sessions) expect(await readFile(join(dir, "details", item.file), "utf8")).not.toContain(secret);
    }
    if (process.platform !== "win32") expect((await stat(run.mcp!.claudeConfigPath)).mode & 0o777).toBe(0o600);
  });
});
