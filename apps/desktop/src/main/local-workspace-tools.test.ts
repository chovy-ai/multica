// @vitest-environment node
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceTools, type WorkspaceToolOptions } from "./local-workspace-tools";
import { LocalMulticaContext } from "./local-multica-context";
import { LocalConversationService } from "./local-conversation-service";
import { CONTEXT_MCP_TOKEN_ENV } from "./local-context-mcp";
import { providerArgs, runLocalProvider } from "./local-provider-runner";
import { CREATE_TASK_MENTION_ID } from "@multica/tutti-agent-gui-host/local-protocol";

type Row = Record<string, unknown>;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const scope = { userId: "user", workspaceId: "workspace" };
const taskId = "01a170bf-70d1-7193-ab74-865a5fcff14f";
const payload = (result: Awaited<ReturnType<Client["callTool"]>>) => {
  const block = (result.content as { type: string; text?: string }[]).find((entry) => entry.type === "text")!;
  if (result.isError) throw new Error(block.text);
  return JSON.parse(block.text!) as Row;
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "multica-workspace-tools-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const resources: Record<string, Row> = {
    "/api/issues/task": { id: "task", workspace_id: "workspace", title: "Original", status: "todo", revision: 3 },
    "/api/projects/project": { id: "project", workspace_id: "workspace", title: "Project" },
    "/api/agents/reviewer": { id: "reviewer", workspace_id: "workspace", name: "Reviewer", instructions: "Review code", custom_env: { API_KEY: "private-key" }, remote_mcp_daemon_token: "private-daemon-token" },
    "/api/agents/foreign": { id: "foreign", workspace_id: "other", name: "Foreign" },
    "/api/squads/team": { id: "team", workspace_id: "workspace", name: "Team", leader_id: "reviewer" },
    "/api/skills/skill": { id: "skill", workspace_id: "workspace", name: "Skill", content: "Review instructions" },
    "/api/autopilots/automation": { id: "automation", workspace_id: "workspace", title: "Daily review", assignee_id: "reviewer", assignee_type: "agent", status: "active", triggers: [{ id: "schedule", kind: "schedule", timezone: "America/Los_Angeles" }, { id: "hook", kind: "webhook", webhook_token: "private-webhook-token" }] },
    "/api/chat/sessions/chat": { id: "chat", workspace_id: "workspace", agent_id: "reviewer", title: "Review" },
  };
  const requests: { method: string; path: string; body: unknown }[] = [];
  let failWrite = false;
  const request: WorkspaceToolOptions["request"] = vi.fn(async (method, path, body) => {
    requests.push({ method, path, body }); const url = new URL(path, "http://test"); const route = url.pathname;
    const input = body as Row;
    if (method === "GET") {
      if (route === "/api/workspaces/workspace") return { id: "workspace", name: "Workspace", slug: "test" };
      if (route === "/api/workspaces/workspace/members") return [{ id: "membership", user_id: "user", name: "User" }];
      if (route === "/api/issue-statuses") return [{ key: "todo", name: "Todo" }, { key: "done", name: "Done" }];
      if (route === "/api/labels") return [{ id: "bug", name: "Bug", workspace_id: "workspace" }];
      if (route === "/api/issues/task/timeline") return { entries: [{ id: "event-a" }, { id: "event-b" }, { id: "event-c" }], has_more_before: true, has_more_after: false, next_cursor: null };
      if (route === "/api/inbox" || route === "/api/inbox/archived") return [{ id: "notification", workspace_id: "workspace" }];
      if (route === "/api/workspaces/workspace/mcp-servers") return [{ id: "catalog-mcp", name: "Docs", headers: { Authorization: "private-header" } }];
      if (route === "/api/projects/project/resources") return [{ id: "repo", resource_type: "github_repo", resource_ref: { url: "https://github.com/example/project" } }];
      if (route === "/api/agents/reviewer/skills") return [{ id: "skill" }];
      if (route === "/api/agents/reviewer/mcp-servers") return [{ id: "binding", server_id: "catalog-mcp", enabled: true }];
      if (route === "/api/squads/team/members") return [{ member_type: "agent", member_id: "reviewer", role: "reviewer" }];
      if (route === "/api/skills/skill/files") return [{ id: "file", path: "references/checklist.md", content: "Checklist" }];
      if (route === "/api/chat/sessions/chat/tasks") return { items: [{ id: "run", workspace_id: "workspace", status: "completed", remote_mcp_daemon_token: "private-daemon-token" }], has_more: true, next_cursor: "older" };
      if (route === "/api/tasks/run/messages") return [{ seq: 1, type: "thinking", content: "private-reasoning" }, { seq: 2, type: "text", content: "Review result" }, { seq: 3, type: "tool_result", output: "Observable output", output_truncated: true }].filter((entry) => entry.seq > Number(url.searchParams.get("since") ?? 0));
      if (route === "/api/autopilots/automation/runs") return { runs: [{ id: "autopilot-run", status: "completed" }], total: 1 };
      if (route === "/api/autopilots/automation") { const { triggers, ...autopilot } = resources[route]!; return { autopilot, triggers, collaborators: [] }; }
      if (resources[route]) return structuredClone(resources[route]);
      if (route === "/api/issues" || route === "/api/issues/search") return { issues: [resources["/api/issues/task"]], has_more: true };
      if (["/api/projects", "/api/agents", "/api/squads", "/api/skills", "/api/autopilots"].includes(route)) {
        const items = Object.entries(resources).filter(([key, value]) => key.startsWith(`${route}/`) && value.workspace_id === "workspace").map(([, value]) => value);
        return route === "/api/projects" ? { projects: items, total: items.length } : route === "/api/autopilots" ? { autopilots: items, total: items.length } : items;
      }
    } else {
      if (failWrite) throw new Error("Uncertain write result");
      if (["/api/issues", "/api/projects", "/api/agents", "/api/squads", "/api/skills", "/api/autopilots", "/api/chat/sessions"].includes(route) && method === "POST") {
        const created = { ...input, id: taskId, workspace_id: "workspace", identifier: "TES-200", status: "todo" };
        resources[`${route}/${taskId}`] = created; return created;
      }
      if (route.endsWith("/messages")) return { task_id: "run", message_id: "message", queued: true };
      if (resources[route]) {
        if (method === "DELETE") { delete resources[route]; return null; }
        return resources[route] = { ...resources[route], ...input };
      }
      if (route === "/api/agents/reviewer/skills/add" || route === "/api/agents/reviewer/mcp-servers" || route === "/api/squads/team/members" || route.includes("/enabled") || route.includes("/triggers") || route.includes("/resources") || route.includes("/pull-requests") || route.includes("/labels") || route.includes("/comments") || route.includes("/inbox/") || route === "/api/tasks/run/cancel" || route.endsWith("/rerun") || route.endsWith("/trigger")) return { id: "child-resource", ...input };
    }
    throw new Error(`Unexpected API operation: ${method} ${path}`);
  });
  const service = new LocalConversationService({ root: join(root, "conversations"), apiUrl: "https://example.test", find: async () => join(root, "test-owned-missing-provider"), chooseDirectory: async () => null, notify: () => {}, run: async () => ({ output: "Saved reply", sessionId: "fake-native" }), fork: async () => "fake-independent-native", usage: { read: vi.fn(), reset: vi.fn() } });
  service.setCurrentUser(scope.userId); cleanups.push(() => service.stop());
  const source = await service.request(scope, "create", { provider: "codex", title: "Source" });
  const options: WorkspaceToolOptions = { workspaceId: scope.workspaceId, userId: scope.userId, conversationId: source.id, appUrl: "https://multica.example", request, local: { request: (method, params) => service.request(scope, method, params) } };
  const tools = createWorkspaceTools(options); let counter = 0;
  const call = (name: string, input: Row = {}) => {
    const tool = tools.find((entry) => entry.name === name)!;
    return tool.call({ ...(!tool.annotations.readOnlyHint ? { request_id: `test-${++counter}` } : {}), ...input }, new AbortController().signal) as Promise<Row>;
  };
  return { root, request, requests, resources, service, source, options, tools, call, failWrite: () => { failWrite = true; } };
}

describe("scoped Multica workspace operations", () => {
  it("lists scoped catalogs, filters current-user tasks, and returns honest pagination and public agent data", async () => {
    const { call, requests, tools } = await fixture();
    const info = await call("workspace_info"); expect(info.current_user_id).toBe("user");
    const page = await call("list_workspace_items", { kind: "task", mine: true, status: "todo", limit: 1 });
    expect(page).toMatchObject({ has_more: true, next_offset: 1 });
    expect(requests.at(-1)?.path).toContain("assignee_id=user&assignee_type=member");
    const agent = await call("read_workspace_item", { kind: "agent", id: "reviewer" });
    expect(JSON.stringify(agent)).not.toContain("private-"); expect(agent).toHaveProperty("skills");
    expect(tools.some((tool) => /runtime|preview|shell|filesystem|http_request/.test(tool.name))).toBe(false);
  });
  it("creates and updates a task through exact existing DTO fields, preserving text and links", async () => {
    const { call, requests } = await fixture();
    const task = await call("create_task", { title: "中文任务", description: "First line\nSecond line\\literal", assignee_type: "agent", assignee_id: "reviewer", project_id: "project", parent_issue_id: "task" });
    expect(task).toMatchObject({ id: taskId, action: "created", url: `https://multica.example/test/issues/${taskId}` });
    const created = requests.find((entry) => entry.method === "POST" && entry.path === "/api/issues")!;
    expect(created.body).toEqual({ title: "中文任务", description: "First line\nSecond line\\literal", assignee_type: "agent", assignee_id: "reviewer", project_id: "project", parent_issue_id: "task" });
    expect(created.body).not.toHaveProperty("request_id");
    await call("update_task", { id: "task", status: "done", expected_revision: 3, suppress_run: true });
    expect(requests).toContainEqual({ method: "PUT", path: "/api/issues/task", body: { status: "done", expected_revision: 3, suppress_run: true } });
    const comment = await call("comment_task", { id: "task", content: "Reviewed" });
    expect(comment.id).toBe("task"); expect(comment.url).toBe("https://multica.example/test/issues/task");
    await call("set_task_label", { id: "task", label_id: "bug", attached: true });
    expect(requests).toContainEqual({ method: "POST", path: "/api/issues/task/labels", body: { label_id: "bug" } });
    await call("manage_task_pull_request", { id: "task", action: "link", url: "https://github.com/example/project/pull/42" });
    expect(requests).toContainEqual({ method: "POST", path: "/api/issues/task/pull-requests", body: { url: "https://github.com/example/project/pull/42" } });
  });
  it("uses the actual task search route, preserves filtered-page progress and pages wrapped project catalogs", async () => {
    const { call, resources, requests } = await fixture();
    const search = await call("list_workspace_items", { kind: "task", query: "Original", status: "done", limit: 100 });
    expect(search).toMatchObject({ items: [], has_more: true, next_offset: 1 });
    expect(requests.at(-1)?.path).toBe("/api/issues/search?q=Original&limit=50&offset=0&include_closed=true");
    resources["/api/projects/second"] = { id: "second", workspace_id: "workspace", title: "Second" };
    expect(await call("list_workspace_items", { kind: "project", limit: 1 })).toMatchObject({ items: [{ id: "project" }], has_more: true, next_offset: 1 });
    expect(await call("list_workspace_items", { kind: "project", limit: 1, offset: 1 })).toMatchObject({ items: [{ id: "second" }], has_more: false, next_offset: null });
  });
  it("deduplicates simultaneous writes and retains uncertain results without blindly retrying", async () => {
    const { call, requests, failWrite } = await fixture();
    const input = { title: "Only once", request_id: "same-operation" };
    const [first, second] = await Promise.all([call("create_task", input), call("create_task", input)]);
    expect(first).toEqual(second); expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
    await expect(call("create_task", { ...input, title: "Different" })).rejects.toThrow("different operation");
    failWrite(); const uncertain = { title: "Unknown result", request_id: "uncertain" };
    await expect(call("create_task", uncertain)).rejects.toThrow("Uncertain");
    await expect(call("create_task", uncertain)).rejects.toThrow("Uncertain");
    expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(2);
  });
  it("paginates timeline snapshots without hiding the server's hard-cap truncation", async () => {
    const { call, requests } = await fixture();
    expect(await call("task_activity", { id: "task", view: "timeline", limit: 2 })).toMatchObject({ items: [{ id: "event-a" }, { id: "event-b" }], has_more: true, next_offset: 2, source_truncated: true });
    expect(await call("task_activity", { id: "task", view: "timeline", limit: 2, offset: 2 })).toMatchObject({ items: [{ id: "event-c" }], has_more: false, next_offset: null, source_truncated: true });
    expect(requests.at(-1)?.path).toBe("/api/issues/task/timeline?limit=2");
  });
  it("rejects foreign workspace references, unknown fields, unsafe IDs and stale deletion names before writing", async () => {
    const { call, requests } = await fixture();
    await expect(call("create_task", { title: "Wrong", assignee_type: "agent", assignee_id: "foreign" })).rejects.toThrow("outside");
    await expect(call("update_task", { id: "task", title: "Edit", workspace_id: "other" })).rejects.toThrow();
    await expect(call("read_workspace_item", { kind: "agent", id: "../foreign" })).rejects.toThrow();
    await expect(call("delete_workspace_item", { kind: "task", id: "task", expected_name: "Stale title" })).rejects.toThrow("does not match");
    expect(requests.every((entry) => entry.method === "GET")).toBe(true);
    await call("delete_workspace_item", { kind: "task", id: "task", expected_name: "Original" });
    expect(requests.some((entry) => entry.method === "DELETE")).toBe(true);
  });
  it("manages project repository metadata, agent Skills/MCP bindings and squad roles without filesystem or credential operations", async () => {
    const { call, requests } = await fixture();
    await call("create_project", { title: "Project", lead_type: "member", lead_id: "user" });
    await call("manage_project_repository", { project_id: "project", action: "add", url: "https://github.com/example/project", ref: "main" });
    expect(requests).toContainEqual({ method: "POST", path: "/api/projects/project/resources", body: { resource_type: "github_repo", resource_ref: { url: "https://github.com/example/project", ref: "main" } } });
    await call("create_agent", { name: "Reviewer", instructions: "Review", runtime_id: "existing-runtime", skill_ids: ["skill"] });
    await call("update_agent", { id: "reviewer", model: "configured-model" });
    await call("assign_agent_skill", { agent_id: "reviewer", skill_id: "skill", action: "add" });
    expect(requests).toContainEqual({ method: "POST", path: "/api/agents/reviewer/skills/add", body: { skill_ids: ["skill"] } });
    expect(JSON.stringify(await call("agent_mcp_servers", { agent_id: "reviewer" }))).not.toContain("private-header");
    await call("assign_agent_mcp", { agent_id: "reviewer", server_id: "catalog-mcp", action: "enable" });
    expect(requests).toContainEqual({ method: "PUT", path: "/api/agents/reviewer/mcp-servers/catalog-mcp/enabled", body: { enabled: true } });
    await call("create_squad", { name: "Team", leader_id: "reviewer" });
    await call("manage_squad_member", { squad_id: "team", action: "add", member_type: "agent", member_id: "reviewer", role: "reviewer" });
    await call("create_skill", { name: "Review checklist", content: "Check changes", files: [{ path: "references/checklist.md", content: "Checklist" }] });
    await call("update_skill", { id: "skill", content: "Updated checklist" });
    expect(requests.some((entry) => /\/env|\/runtimes|\/config/.test(entry.path))).toBe(false);
  });
  it("uses real automation execution modes and explicit timezones, manages schedules and filters webhook secrets", async () => {
    const { call, requests } = await fixture();
    await call("create_autopilot", { title: "Daily review", assignee_id: "reviewer", execution_mode: "create_issue" });
    await call("update_autopilot", { id: "automation", status: "paused" });
    await expect(call("manage_autopilot_schedule", { autopilot_id: "automation", action: "create", cron_expression: "0 9 * * 1-5" })).rejects.toThrow("timezone");
    await call("manage_autopilot_schedule", { autopilot_id: "automation", action: "create", cron_expression: "0 9 * * 1-5", timezone: "America/Los_Angeles" });
    expect(requests).toContainEqual({ method: "POST", path: "/api/autopilots/automation/triggers", body: { kind: "schedule", cron_expression: "0 9 * * 1-5", timezone: "America/Los_Angeles" } });
    await expect(call("manage_autopilot_schedule", { autopilot_id: "automation", action: "remove", trigger_id: "hook" })).rejects.toThrow("Schedule trigger");
    await call("manage_autopilot_webhook", { autopilot_id: "automation", action: "create", provider: "github", event_filters: [{ event: "pull_request", actions: ["opened"] }] });
    expect(requests).toContainEqual({ method: "POST", path: "/api/autopilots/automation/triggers", body: { kind: "webhook", provider: "github", event_filters: [{ event: "pull_request", actions: ["opened"] }] } });
    expect(JSON.stringify(await call("read_workspace_item", { kind: "autopilot", id: "automation" }))).not.toContain("private-webhook-token");
    await call("trigger_autopilot", { id: "automation" }); await call("autopilot_runs", { id: "automation" });
    await call("update_inbox_item", { id: "notification", action: "archive" });
  });
  it("submits an agent, reads its real run output and refuses unrelated execution IDs", async () => {
    const { call, requests } = await fixture();
    const started = await call("invoke_agent", { agent_id: "reviewer", session_id: "chat", content: "Review this", model: "configured-model" });
    expect(started).toMatchObject({ conversation_id: "chat", task_id: "run", status: "submitted" });
    expect(requests).toContainEqual({ method: "POST", path: "/api/chat/sessions/chat/messages", body: { content: "Review this", model: "configured-model" } });
    const runs = await call("conversation_runs", { session_id: "chat" }); expect(runs.next_cursor).toBe("older"); expect(JSON.stringify(runs)).not.toContain("private-daemon-token");
    const first = await call("run_messages", { run_id: "run", conversation_id: "chat", limit: 1 });
    expect(first).toMatchObject({ items: [{ seq: 2, content: "Review result" }], has_more: true, next_seq: 2 });
    const second = await call("run_messages", { run_id: "run", conversation_id: "chat", since_seq: 2 });
    expect(second).toMatchObject({ items: [{ seq: 3, output_truncated: true }], has_more: false });
    await expect(call("run_messages", { run_id: "someone-elses-run", conversation_id: "chat" })).rejects.toThrow("not found");
    expect(requests.some((entry) => entry.path.includes("/api/tasks/someone-elses-run"))).toBe(false);
    await call("cancel_run", { run_id: "run", conversation_id: "chat" });
  });
  it("persists local Fork/Side lineage and blocks recursive sends without exposing native session IDs", async () => {
    const { call, source, service } = await fixture();
    const sent = await service.request(scope, "send", { id: source.id, content: "Saved question" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: source.id })).turns[0]?.status).toBe("completed"));
    const fork = await call("fork_conversation", { id: source.id, turn_id: sent.turnId });
    expect(fork.forked_from).toBe(source.id); expect(fork).not.toHaveProperty("providerSessionId");
    const side = await call("create_side_conversation", { id: source.id, turn_id: sent.turnId, quote: "Saved question" });
    expect(side.source_id).toBe(source.id);
    const branches = await call("list_conversation_branches", { source_id: source.id });
    expect(branches.items).toHaveLength(3); expect(JSON.stringify(branches)).not.toContain("fake-native");
    await call("update_conversation", { source: "local", id: fork.id, title: "Renamed", archived: true });
    expect((await service.request(scope, "read", { id: String(fork.id) })).title).toBe("Renamed");
    await expect(call("send_conversation_message", { source: "local", id: source.id, content: "Recursive" })).rejects.toThrow("recursively");
  });
});

describe("automatic workspace MCP registration", () => {
  it("exposes operations over real MCP with scoped HTTP credentials and preserves the New task action", async () => {
    const f = await fixture(); const seenHeaders: Row[] = [];
    const api = createServer(async (incoming, response) => {
      seenHeaders.push({ authorization: incoming.headers.authorization, workspace: incoming.headers["x-workspace-id"] });
      if (incoming.headers.authorization !== "Bearer cloud-private" || incoming.headers["x-workspace-id"] !== "workspace") { response.writeHead(403).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        const result = await f.request(incoming.method as "GET" | "POST", incoming.url!, body, new AbortController().signal);
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
      } catch { response.writeHead(403).end(JSON.stringify({ error: "Private server error cloud-private" })); }
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { api.closeAllConnections(); api.close(() => resolve()); }));
    const apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    const context = new LocalMulticaContext({ root: join(f.root, "context"), apiUrl, appUrl: "https://multica.example", cliPath: join(f.root, "test-owned-missing-cli"), workspaceOperations: true,
      readProfile: async () => ({ userId: "user", token: "cloud-private", serverUrl: apiUrl }), verifyAccount: async () => "user", localActions: () => f.options.local! });
    const executable = join(f.root, "test-owned-native");
    await writeFile(executable, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args.includes('app-server')) {
  require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id)console.log(JSON.stringify({id:r.id,result:r.method==='config/read'?{config:{}}:{}}));});
} else {
  process.stdin.resume(); process.stdin.on('end',async()=>{
    let url,headers;
    if(args.includes('--mcp-config')) {
      const c=JSON.parse(require('node:fs').readFileSync(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers.multica_desktop_context;
      url=c.url;headers=c.headers;
      if(!args[args.indexOf('--allowedTools')+1].includes('mcp__multica_desktop_context__create_task'))throw new Error('Missing write tool registration');
    } else {
      const c=args.find(v=>v.startsWith('mcp_servers.multica_desktop_context='));url=JSON.parse(c.match(/url=("[^"]+")/)[1]);headers={Authorization:'Bearer '+process.env.MULTICA_CONTEXT_MCP_TOKEN};
    }
    let id=0; const rpc=async(method,params)=>{const r=await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});const j=await r.json();if(j.error)throw new Error(j.error.message);return j.result;};
    await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fake-provider',version:'1'}});
    const r=await rpc('tools/call',{name:'create_task',arguments:{title:'Native delegated task',request_id:'native-operation'}});if(r.isError)throw new Error(r.content[0].text);
    const output=JSON.stringify({task:JSON.parse(r.content[0].text).id,resumed:args.includes('--resume')||args.includes('resume')});
    if(args[0]==='exec') {
      console.log(JSON.stringify({type:'thread.started',thread_id:'fake-native'}));
      console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:output}}));
    } else console.log(JSON.stringify({type:'result',session_id:'fake-native',is_error:false,result:output}));
  });
}
`, { mode: 0o700 });
    for (const references of [[], [{ kind: "issue" as const, id: CREATE_TASK_MENTION_ID }]]) {
      const execution = await context.prepare(scope, new AbortController().signal, { conversationId: f.source.id, references });
      cleanups.push(() => execution.dispose());
      const client = new Client({ name: "workspace-operation-test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(execution.mcp!.url), { requestInit: { headers: { Authorization: `Bearer ${execution.env[CONTEXT_MCP_TOKEN_ENV]}` } } }));
      cleanups.push(() => client.close());
      const catalog = await client.listTools(); expect(catalog.tools.filter((tool) => tool.name === "create_task")).toHaveLength(1);
      expect(catalog.tools.find((tool) => tool.name === "update_task")?.annotations?.readOnlyHint).toBe(false);
      expect(catalog.tools.find((tool) => tool.name === "delete_workspace_item")?.annotations?.destructiveHint).toBe(true);
      expect(catalog.tools.find((tool) => tool.name === "workspace_info")?.annotations?.readOnlyHint).toBe(true);
      expect(execution.systemPrompt).toContain("Submission is not completion");
      const claudeArgs = providerArgs("claude", undefined, undefined, execution.systemPrompt, execution.mcp);
      expect(claudeArgs[claudeArgs.indexOf("--allowedTools") + 1]).toContain("mcp__multica_desktop_context__invoke_agent");
      expect(claudeArgs).not.toContain("--dangerously-skip-permissions");
      const created = payload(await client.callTool({ name: "create_task", arguments: { title: "Requested task", request_id: "create-once" } }));
      expect(created.id).toBe(taskId);
      const found = payload(await client.callTool({ name: "search_context", arguments: { kind: "task", query: "Original" } }));
      expect(found.results).toEqual([expect.objectContaining({ id: "task", title: "Original" })]);
      const agent = payload(await client.callTool({ name: "read_workspace_item", arguments: { kind: "agent", id: "reviewer" } }));
      expect(JSON.stringify(agent)).not.toContain("private-");
      const denied = await client.callTool({ name: "read_workspace_item", arguments: { kind: "agent", id: "foreign" } });
      expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).not.toContain("cloud-private");
      const forbidden = await client.callTool({ name: "read_workspace_item", arguments: { kind: "project", id: "denied" } });
      expect(forbidden.isError).toBe(true); expect(JSON.stringify(forbidden)).toContain("HTTP 403"); expect(JSON.stringify(forbidden)).not.toContain("cloud-private");
      if (process.platform !== "win32") for (const provider of ["codex", "claude"] as const) for (const resume of [undefined, "fake-native"]) {
        const result = await runLocalProvider({ provider, cwd: f.root, content: "Create the requested task", systemPrompt: execution.systemPrompt, env: { ...execution.env, HOME: f.root, CLAUDE_CONFIG_DIR: join(f.root, "test-claude-config") }, mcp: execution.mcp, resume }, () => {}, new AbortController().signal, executable);
        expect(JSON.parse(result.output)).toEqual({ task: taskId, resumed: Boolean(resume) });
      }
    }
    expect(seenHeaders.length).toBeGreaterThan(0); expect(seenHeaders.every((entry) => entry.workspace === "workspace")).toBe(true);
  }, 20_000);
  it("keeps local operations available offline without exposing cloud mutation tools or using another profile", async () => {
    const f = await fixture();
    const context = new LocalMulticaContext({ root: join(f.root, "offline"), apiUrl: "https://example.test", cliPath: join(f.root, "missing-cli"), workspaceOperations: true, readProfile: async () => { throw new Error("Offline"); }, localActions: () => f.options.local! });
    const run = await context.prepare(scope, new AbortController().signal); cleanups.push(() => run.dispose());
    expect(run.mcp?.tools).toContain("fork_conversation"); expect(run.mcp?.tools).not.toContain("create_task"); expect(run.mcp?.tools).not.toContain("invoke_agent");
    expect(f.requests).toHaveLength(0);
  });
});
