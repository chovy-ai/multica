import { z } from "zod";
import { paths } from "@multica/core/paths";
import type { LocalConversationMethods } from "@multica/core/local-conversation/protocol";
import { createAgentAvatarTool, type AgentAvatarOptions } from "./local-agent-avatar";

type Row = Record<string, unknown>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type LocalMethod = "create" | "update" | "fork" | "send" | "cancel" | "sideCreate" | "read" | "list";
export interface WorkspaceToolOptions {
  workspaceId: string;
  userId: string;
  conversationId?: string;
  appUrl?: string;
  avatar?: Pick<AgentAvatarOptions, "receiptsRoot" | "readFile">;
  request(method: Method, path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
  local?: { request<M extends LocalMethod>(method: M, params: LocalConversationMethods[M]["params"]): Promise<LocalConversationMethods[M]["result"]> };
}
export interface WorkspaceMcpTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  call(input: Row, signal: AbortSignal): Promise<unknown>;
}

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const short = z.string().trim().min(1).max(256);
const text = z.string().max(100_000);
const optionalText = text.optional();
const optionalId = id.nullable().optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const assigneeType = z.enum(["member", "agent", "squad"]);
const resourceKind = z.enum(["task", "project", "agent", "squad", "skill", "autopilot", "conversation"]);
type Kind = z.infer<typeof resourceKind>;
const roots: Record<Kind, string> = { task: "/api/issues", project: "/api/projects", agent: "/api/agents", squad: "/api/squads", skill: "/api/skills", autopilot: "/api/autopilots", conversation: "/api/chat/sessions" };
const localSource = z.enum(["local", "cloud"]).default("local");
const paging = { limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).max(1_000_000).default(0) };
const taskFields = { title: short.optional(), description: optionalText, status: short.optional(), priority: short.optional(), assignee_type: assigneeType.nullable().optional(), assignee_id: optionalId, project_id: optionalId, parent_issue_id: optionalId, stage: z.number().int().min(1).optional(), start_date: date, due_date: date };
const projectFields = { title: short.optional(), description: optionalText, status: short.optional(), priority: short.optional(), lead_type: assigneeType.nullable().optional(), lead_id: optionalId, start_date: date, due_date: date };
const agentFields = { name: short.optional(), description: optionalText, instructions: optionalText, model: z.string().max(200).optional(), thinking_level: z.string().max(100).optional(), max_concurrent_tasks: z.number().int().min(1).max(100).optional() };
const squadFields = { name: short.optional(), description: optionalText, instructions: optionalText, leader_id: id.optional() };
const skillFiles = z.array(z.object({ path: z.string().min(1).max(512), content: text }).strict()).max(50).optional();
const skillFields = { name: short.optional(), description: optionalText, content: optionalText, files: skillFiles };
const autopilotFields = { title: short.optional(), description: optionalText, project_id: optionalId, assignee_type: z.enum(["agent", "squad"]).optional(), assignee_id: id.optional(), execution_mode: z.enum(["create_issue", "run_only"]).optional(), issue_title_template: z.string().max(1024).optional() };

function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Multica returned an invalid object");
  return value as Row;
}
function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error("Multica returned an invalid list");
  return value.map(row);
}
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((entry) => !(entry && typeof entry === "object" && "type" in entry && entry.type === "thinking")).map(clean);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:^|_)(?:token|secret|password|credentials?)(?:$|_)/i.test(key) && !/^(custom_env|mcp_config|runtime_config|custom_args|system_instructions|system_prompt|authorization|headers|env|api_key|webhook_path|webhook_url|remote_mcp_connections|plugin_hook_tools)$/i.test(key)).map(([key, entry]) => [key, clean(entry)]));
}
function query(path: string, values: Row): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  return `${path}${params.size ? `?${params}` : ""}`;
}
function nonempty(value: Row): Row {
  if (!Object.keys(value).length) throw new Error("Supply at least one field to update");
  return value;
}

/** Explicit business tools only: no arbitrary HTTP, shell, filesystem or runtime controls. */
export function createWorkspaceTools(options: WorkspaceToolOptions): WorkspaceMcpTool[] {
  const tools: WorkspaceMcpTool[] = [];
  if (options.avatar && options.conversationId) tools.push(createAgentAvatarTool({ ...options, ...options.avatar, conversationId: options.conversationId }));
  const writes = new Map<string, { input: string; result: Promise<unknown> }>();
  let workspace: Promise<Row> | undefined;
  const request = async (method: Method, path: string, body: unknown, signal: AbortSignal) => {
    signal.throwIfAborted();
    const result = await options.request(method, path, body, signal);
    signal.throwIfAborted(); return result;
  };
  const get = (path: string, signal: AbortSignal) => request("GET", path, undefined, signal);
  const workspaceInfo = (signal: AbortSignal) => workspace ??= get(`/api/workspaces/${options.workspaceId}`, signal).then(row).then((value) => {
    if (value.id !== options.workspaceId) throw new Error("Workspace identity mismatch");
    return value;
  }).catch((error) => { workspace = undefined; throw error; });
  const ensure = async (kind: Kind, identity: string, signal: AbortSignal): Promise<Row> => {
    const response = row(await get(`${roots[kind]}/${identity}`, signal));
    const value = kind === "autopilot" && response.autopilot ? { ...row(response.autopilot), triggers: response.triggers, collaborators: response.collaborators } : response;
    if (value.workspace_id !== options.workspaceId) throw new Error("Resource is outside the selected workspace");
    return value;
  };
  const members = async (signal: AbortSignal) => rows(await get(`/api/workspaces/${options.workspaceId}/members`, signal));
  const ensureAssignee = async (type: unknown, identity: unknown, signal: AbortSignal) => {
    if (!identity) return;
    if (type === "agent" || type === "squad") await ensure(type, String(identity), signal);
    else if (type === "member") {
      if (!(await members(signal)).some((member) => member.user_id === identity || member.id === identity)) throw new Error("Member is outside the selected workspace");
    } else throw new Error("Provide assignee_type together with assignee_id");
  };
  const taskRefs = async (value: Row, signal: AbortSignal) => {
    if (value.project_id) await ensure("project", String(value.project_id), signal);
    if (value.parent_issue_id) await ensure("task", String(value.parent_issue_id), signal);
    await ensureAssignee(value.assignee_type, value.assignee_id, signal);
  };
  const ensureRun = async (runId: string, conversationId: string | undefined, taskId: string | undefined, before: string | undefined, signal: AbortSignal) => {
    if (Boolean(conversationId) === Boolean(taskId)) throw new Error("Supply exactly one owning conversation_id or task_id");
    await ensure(conversationId ? "conversation" : "task", (conversationId ?? taskId)!, signal);
    const path = conversationId ? `${roots.conversation}/${conversationId}/tasks` : `${roots.task}/${taskId}/task-runs`;
    const value = await get(query(path, { limit: 200, before }), signal);
    const list = rows(Array.isArray(value) ? value : row(value).items);
    if (!list.some((entry) => entry.id === runId && entry.workspace_id === options.workspaceId)) throw new Error("Execution not found in this owner's page. For older runs, pass its list cursor as runs_before.");
  };
  const receipt = async (kind: Kind, action: string, value: unknown, signal: AbortSignal, identity?: string) => {
    const object = value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
    if (action === "created" && (!id.safeParse(object.id).success || object.workspace_id !== options.workspaceId)) throw new Error("The server did not confirm a created resource in this workspace. Inspect current state before trying again.");
    if (object.workspace_id && object.workspace_id !== options.workspaceId) throw new Error("The response is outside the selected workspace");
    const resourceId = identity ?? object.id;
    let url: string | null = null;
    if (options.appUrl && resourceId) {
      try {
        const ws = await workspaceInfo(signal);
        if (typeof ws.slug === "string") {
          const scopePaths = paths.workspace(ws.slug);
          const build = { task: scopePaths.issueDetail, project: scopePaths.projectDetail, agent: scopePaths.agentDetail, squad: scopePaths.squadDetail, skill: scopePaths.skillDetail, autopilot: scopePaths.autopilotDetail, conversation: scopePaths.chatSession }[kind];
          url = new URL(build(String(resourceId)), options.appUrl).href;
        }
      } catch { /* A successful write must not be reported as failed because its link lookup failed. */ }
    }
    return { kind, action, id: resourceId ?? null, workspace_id: options.workspaceId, url, data: clean(value) };
  };
  function tool<S extends z.ZodRawShape>(name: string, description: string, schema: S, run: (input: z.infer<z.ZodObject<S>>, signal: AbortSignal, requestId?: string) => Promise<unknown>, write = false, destructive = false) {
    const inputSchema: z.ZodRawShape = write ? { ...schema, request_id: id.max(128).describe("Stable operation ID. Reuse it with identical arguments after a retry; use a new ID for a new action.") } : schema;
    tools.push({ name, description, inputSchema, annotations: { readOnlyHint: !write, destructiveHint: destructive, idempotentHint: !write, openWorldHint: write },
      call: async (raw, signal) => {
        signal.throwIfAborted();
        const parsed = z.object(inputSchema).strict().parse(raw);
        const { request_id: requestId, ...input } = parsed;
        const perform = () => run(z.object(schema).strict().parse(input), signal, typeof requestId === "string" ? requestId : undefined).then(clean);
        if (!write) return perform();
        const key = `${name}:${requestId}`, serialized = JSON.stringify(input);
        const existing = writes.get(key);
        if (existing) {
          if (existing.input !== serialized) throw new Error("This request_id already belongs to a different operation");
          return existing.result;
        }
        // Keep ambiguous failures too: retrying an uncertain write must not duplicate it.
        const result = perform(); writes.set(key, { input: serialized, result });
        return result;
      },
    });
  }

  tool("workspace_info", "Read the selected workspace and its members, issue statuses and labels. Use IDs from this catalog rather than guessing assignees or status keys.", {}, async (_, signal) => {
    const [current, people, statuses, labels] = await Promise.all([workspaceInfo(signal), members(signal), get("/api/issue-statuses", signal), get("/api/labels", signal)]);
    return { workspace: { id: current.id, name: current.name, slug: current.slug }, current_user_id: options.userId, members: people, statuses, labels };
  });
  tool("list_workspace_items", "List or search tasks, projects, defined Multica agents, squads, Skills or automations in the current workspace. Tasks support status/project/assignee filters; mine=true selects the current member's tasks. Follow next_offset for more results.", {
    kind: z.enum(["task", "project", "agent", "squad", "skill", "autopilot"]), query: z.string().max(200).default(""), ...paging, status: short.optional(), project_id: id.optional(), assignee_id: id.optional(), mine: z.boolean().default(false),
  }, async ({ kind, query: search, limit, offset, ...filters }, signal) => {
    let value: unknown;
    const effectiveLimit = kind === "task" && search ? Math.min(limit, 50) : limit;
    if (kind === "task") value = await get(search ? query(`${roots.task}/search`, { q: search, limit: effectiveLimit, offset, include_closed: true }) : query(roots.task, { limit, offset, status: filters.status, project_id: filters.project_id, assignee_id: filters.mine ? options.userId : filters.assignee_id, assignee_type: filters.mine ? "member" : undefined }), signal);
    else value = await get(query(roots[kind], { workspace_id: options.workspaceId }), signal);
    let list: Row[], more = false;
    const page = Array.isArray(value) ? undefined : row(value);
    const source = rows(Array.isArray(value) ? value : page!.issues ?? page!.items ?? page![kind === "autopilot" ? "autopilots" : `${kind}s`]);
    if (source.some((entry) => entry.workspace_id && entry.workspace_id !== options.workspaceId)) throw new Error("Resource list is outside the selected workspace");
    let consumed: number;
    if (kind !== "task") {
      const matches = source.filter((entry) => !search || String(entry.title ?? entry.name ?? "").toLowerCase().includes(search.toLowerCase()));
      list = matches.slice(offset, offset + limit); consumed = list.length; more = offset + list.length < matches.length;
    } else {
      consumed = source.length;
      list = search ? source.filter((entry) => (!filters.status || entry.status === filters.status) && (!filters.project_id || entry.project_id === filters.project_id) && (!(filters.mine || filters.assignee_id) || entry.assignee_id === (filters.mine ? options.userId : filters.assignee_id))) : source;
      more = typeof page?.has_more === "boolean" ? page.has_more : source.length === effectiveLimit;
    }
    if (list.some((entry) => entry.workspace_id && entry.workspace_id !== options.workspaceId)) throw new Error("Resource list is outside the selected workspace");
    return { kind, items: list, has_more: more, next_offset: more ? offset + consumed : null };
  });
  tool("read_workspace_item", "Read a project (including resources), defined agent (including assigned Skills), squad (including members), Skill (including bundled files), task, or automation. For full task discussion use read_context. Credentials and private runtime configuration are omitted.", { kind: resourceKind, id }, async (input, signal) => {
    const value = await ensure(input.kind, input.id, signal);
    const child = { project: "resources", agent: "skills", squad: "members", skill: "files" }[input.kind as "project" | "agent" | "squad" | "skill"];
    return { kind: input.kind, data: value, ...(child ? { [child]: value[child] ?? await get(`${roots[input.kind]}/${input.id}/${child}`, signal) } : {}) };
  });

  tool("create_task", "Create a task or subtask. Assigning it to an agent/squad may start execution under the existing workflow. Status keys come from workspace_info. Returns the created object and link.", { ...taskFields, title: short }, async (input, signal) => {
    await taskRefs(input, signal); return receipt("task", "created", await request("POST", roots.task, input, signal), signal);
  }, true);
  tool("update_task", "Update task content, assignee, project, parent, dates or status. Read first; expected_revision detects concurrent edits. suppress_run=true updates assignment/status without starting a run.", { id, ...taskFields, expected_revision: z.number().int().min(0).optional(), suppress_run: z.boolean().optional(), duplicate_of_issue_id: id.optional() }, async ({ id: identity, ...input }, signal) => {
    await ensure("task", identity, signal); await taskRefs(input, signal);
    if (input.duplicate_of_issue_id) await ensure("task", input.duplicate_of_issue_id, signal);
    return receipt("task", "updated", await request("PUT", `${roots.task}/${identity}`, nonempty(input), signal), signal, identity);
  }, true);
  tool("comment_task", "Add a task comment or reply. Only post content the user requested to share. Existing mention/workflow rules may invoke agents.", { id, content: text.min(1), parent_id: optionalId, attachment_ids: z.array(id).max(50).optional(), suppress_agent_ids: z.array(id).max(50).optional() }, async ({ id: identity, ...input }, signal) => {
    await ensure("task", identity, signal); return receipt("task", "commented", await request("POST", `${roots.task}/${identity}/comments`, input, signal), signal, identity);
  }, true);
  tool("task_activity", "Read a task's timeline, subtask list, labels or execution runs. Use run_messages to read observable execution output.", { id, view: z.enum(["timeline", "children", "labels", "task-runs"]), ...paging }, async ({ id: identity, view, ...page }, signal) => {
    await ensure("task", identity, signal);
    const value = await get(query(`${roots.task}/${identity}/${view}`, view === "timeline" ? { limit: page.limit } : {}), signal);
    const wrapped = Array.isArray(value) ? undefined : row(value);
    const all = rows(Array.isArray(value) ? value : wrapped!.entries ?? wrapped!.items);
    const items = all.slice(page.offset, page.offset + page.limit), more = page.offset + items.length < all.length;
    return { items, has_more: more, next_offset: more ? page.offset + items.length : null, source_truncated: wrapped?.has_more_before === true || wrapped?.has_more_after === true };
  });
  tool("set_task_label", "Attach or detach an existing workspace label from a task.", { id, label_id: id, attached: z.boolean() }, async ({ id: identity, label_id, attached }, signal) => {
    await ensure("task", identity, signal);
    const catalog = rows(await get("/api/labels", signal));
    if (!catalog.some((entry) => entry.id === label_id)) throw new Error("Label is outside the selected workspace");
    await request(attached ? "POST" : "DELETE", `${roots.task}/${identity}/labels${attached ? "" : `/${label_id}`}`, attached ? { label_id } : undefined, signal);
    return receipt("task", attached ? "label_attached" : "label_detached", { label_id }, signal, identity);
  }, true);
  tool("manage_task_pull_request", "Read, link or unlink an existing pull request from a task. This changes its Multica association; it does not create, merge or comment on the external pull request.", { id, action: z.enum(["list", "link", "unlink"]), url: z.string().url().optional(), pull_request_id: id.optional() }, async ({ id: identity, action, url, pull_request_id }, signal) => {
    await ensure("task", identity, signal); const base = `${roots.task}/${identity}/pull-requests`;
    if (action === "list") return get(base, signal);
    if (action === "link" && !url && !pull_request_id) throw new Error("Supply a pull request URL or existing pull_request_id");
    if (action === "unlink") {
      const existing = rows(await get(base, signal));
      if (!pull_request_id || !existing.some((entry) => entry.id === pull_request_id || entry.pull_request_id === pull_request_id)) throw new Error("Pull request is not linked to this task");
    }
    const value = await request(action === "link" ? "POST" : "DELETE", action === "link" ? base : `${base}/${pull_request_id}`, action === "link" ? { ...(url ? { url } : {}), ...(pull_request_id ? { pull_request_id } : {}) } : undefined, signal);
    return receipt("task", `pull_request_${action}`, value, signal, identity);
  }, true);
  tool("rerun_task", "Start a new execution for a task using Multica's existing rerun action. This may consume the assigned agent's model quota.", { id }, async ({ id: identity }, signal) => {
    await ensure("task", identity, signal); return receipt("task", "rerun_requested", await request("POST", `${roots.task}/${identity}/rerun`, {}, signal), signal, identity);
  }, true);

  tool("create_project", "Create a project with description, lead and dates.", { ...projectFields, title: short }, async (input, signal) => {
    await ensureAssignee(input.lead_type, input.lead_id, signal); return receipt("project", "created", await request("POST", roots.project, input, signal), signal);
  }, true);
  tool("update_project", "Update a project's title, description, lead, status, priority or dates. Move tasks with update_task(project_id).", { id, ...projectFields }, async ({ id: identity, ...input }, signal) => {
    await ensure("project", identity, signal); await ensureAssignee(input.lead_type, input.lead_id, signal);
    return receipt("project", "updated", await request("PUT", `${roots.project}/${identity}`, nonempty(input), signal), signal, identity);
  }, true);
  tool("manage_project_repository", "Add, update or remove a project's repository resource without cloning or reading files. Existing API resource_type is github_repo; local directory resources and filesystem operations are excluded.", { project_id: id, resource_id: id.optional(), action: z.enum(["add", "update", "remove"]), url: z.string().url().optional(), ref: z.string().max(256).optional(), label: short.optional() }, async ({ project_id, resource_id, action, url, ref, label }, signal) => {
    await ensure("project", project_id, signal);
    if (action !== "add") {
      const resources = rows(await get(`${roots.project}/${project_id}/resources`, signal));
      if (!resource_id || !resources.some((entry) => entry.id === resource_id && entry.resource_type === "github_repo")) throw new Error("Repository resource not found in this project");
    }
    if (action !== "remove" && !url) throw new Error("Supply the repository URL");
    const value = await request(action === "add" ? "POST" : action === "update" ? "PUT" : "DELETE", `${roots.project}/${project_id}/resources${action === "add" ? "" : `/${resource_id}`}`, action === "remove" ? undefined : { ...(action === "add" ? { resource_type: "github_repo" } : {}), resource_ref: { url, ...(ref ? { ref } : {}) }, ...(label ? { label } : {}) }, signal);
    return receipt("project", `repository_${action}`, value, signal, project_id);
  }, true);

  tool("create_agent", "Create a defined Multica agent using an existing runtime_id. This is agent configuration, not a Codex/Claude runner entry. Does not create or manage runtimes, permissions, credentials or environment variables.", { ...agentFields, name: short, runtime_id: id, skill_ids: z.array(id).max(100).optional() }, async (input, signal) => {
    for (const skill of input.skill_ids ?? []) await ensure("skill", skill, signal);
    return receipt("agent", "created", await request("POST", roots.agent, input, signal), signal);
  }, true);
  tool("update_agent", "Update a defined agent's name, description, instructions, model or concurrency. Does not run it or change credentials or invocation permissions.", { id, ...agentFields }, async ({ id: identity, ...input }, signal) => {
    await ensure("agent", identity, signal); return receipt("agent", "updated", await request("PUT", `${roots.agent}/${identity}`, nonempty(input), signal), signal, identity);
  }, true);
  tool("archive_agent", "Archive or restore a defined agent. Archive is reversible and does not erase history.", { id, archived: z.boolean() }, async ({ id: identity, archived }, signal) => {
    await ensure("agent", identity, signal); return receipt("agent", archived ? "archived" : "restored", await request("POST", `${roots.agent}/${identity}/${archived ? "archive" : "restore"}`, {}, signal), signal, identity);
  }, true);
  tool("assign_agent_skill", "Add, remove or enable/disable a Skill on a defined agent. Adding preserves its other Skills.", { agent_id: id, skill_id: id, action: z.enum(["add", "remove", "enable", "disable"]) }, async ({ agent_id, skill_id, action }, signal) => {
    await ensure("agent", agent_id, signal); await ensure("skill", skill_id, signal);
    const base = `${roots.agent}/${agent_id}/skills`;
    const value = action === "add" ? await request("POST", `${base}/add`, { skill_ids: [skill_id] }, signal) : action === "remove" ? await request("DELETE", `${base}/${skill_id}`, undefined, signal) : await request("PUT", `${base}/${skill_id}/enabled`, { enabled: action === "enable" }, signal);
    return receipt("agent", `skill_${action}`, value, signal, agent_id);
  }, true);
  tool("agent_mcp_servers", "Read the workspace MCP library metadata and an agent's current MCP assignments. Does not return server configuration, headers, credentials or environment variables.", { agent_id: id }, async ({ agent_id }, signal) => {
    await ensure("agent", agent_id, signal);
    const [library, assigned] = await Promise.all([get(`/api/workspaces/${options.workspaceId}/mcp-servers`, signal), get(`${roots.agent}/${agent_id}/mcp-servers`, signal)]);
    return { library, assigned };
  });
  tool("assign_agent_mcp", "Add/remove or enable/disable an existing workspace MCP server on a defined agent at the user's explicit request. Does not create servers, change credentials or manage runtimes.", { agent_id: id, server_id: id, action: z.enum(["add", "remove", "enable", "disable"]) }, async ({ agent_id, server_id, action }, signal) => {
    await ensure("agent", agent_id, signal);
    const library = rows(await get(`/api/workspaces/${options.workspaceId}/mcp-servers`, signal));
    if (!library.some((entry) => entry.id === server_id)) throw new Error("MCP server is outside the selected workspace");
    const base = `${roots.agent}/${agent_id}/mcp-servers`;
    const value = action === "add" ? await request("POST", base, { server_id }, signal) : action === "remove" ? await request("DELETE", `${base}/${server_id}`, undefined, signal) : await request("PUT", `${base}/${server_id}/enabled`, { enabled: action === "enable" }, signal);
    return receipt("agent", `mcp_${action}`, value, signal, agent_id);
  }, true);

  tool("create_squad", "Create a squad with an existing defined agent as leader. Assign tasks to the squad to use its existing orchestration.", { name: short, description: optionalText, leader_id: id }, async (input, signal) => {
    await ensure("agent", input.leader_id, signal); return receipt("squad", "created", await request("POST", roots.squad, input, signal), signal);
  }, true);
  tool("update_squad", "Update squad instructions, description, name or leader.", { id, ...squadFields }, async ({ id: identity, ...input }, signal) => {
    await ensure("squad", identity, signal); if (input.leader_id) await ensure("agent", input.leader_id, signal);
    return receipt("squad", "updated", await request("PUT", `${roots.squad}/${identity}`, nonempty(input), signal), signal, identity);
  }, true);
  tool("manage_squad_member", "Add/remove a squad member or update their role. Read the squad first; membership follows existing server rules.", { squad_id: id, member_type: z.enum(["member", "agent"]), member_id: id, role: short.optional(), action: z.enum(["add", "remove", "set_role"]) }, async ({ squad_id, action, ...input }, signal) => {
    await ensure("squad", squad_id, signal); await ensureAssignee(input.member_type, input.member_id, signal);
    if (action !== "remove" && !input.role) throw new Error("Supply the member's role");
    const body = action === "remove" ? { member_type: input.member_type, member_id: input.member_id } : input;
    const value = await request(action === "add" ? "POST" : action === "remove" ? "DELETE" : "PATCH", `${roots.squad}/${squad_id}/members${action === "set_role" ? "/role" : ""}`, body, signal);
    return receipt("squad", `member_${action}`, value, signal, squad_id);
  }, true);

  tool("create_skill", "Create a reusable Skill from instructions and optional bundled text files. This manages Skill content in Multica, not local filesystem files.", { ...skillFields, name: short, content: text.min(1) }, async (input, signal) => receipt("skill", "created", await request("POST", roots.skill, input, signal), signal), true);
  tool("update_skill", "Update a Skill's name, description or instructions. If files is supplied, it follows the existing API's bundle replacement semantics; read the existing bundle first.", { id, ...skillFields }, async ({ id: identity, ...input }, signal) => {
    await ensure("skill", identity, signal); return receipt("skill", "updated", await request("PUT", `${roots.skill}/${identity}`, nonempty(input), signal), signal, identity);
  }, true);

  tool("create_autopilot", "Create an automation assigned to a defined agent or squad. Add a schedule separately with manage_autopilot_schedule. Does not start a run by itself.", { ...autopilotFields, title: short, assignee_id: id }, async (input, signal) => {
    await ensureAssignee(input.assignee_type ?? "agent", input.assignee_id, signal);
    if (input.project_id) await ensure("project", input.project_id, signal);
    return receipt("autopilot", "created", await request("POST", roots.autopilot, input, signal), signal);
  }, true);
  tool("update_autopilot", "Update automation instructions, assignment, project or active/paused status. Does not alter trigger credentials.", { id, ...autopilotFields, status: z.enum(["active", "paused"]).optional() }, async ({ id: identity, ...input }, signal) => {
    const current = await ensure("autopilot", identity, signal);
    await ensureAssignee(input.assignee_type ?? current.assignee_type ?? "agent", input.assignee_id, signal);
    if (input.project_id) await ensure("project", input.project_id, signal);
    return receipt("autopilot", "updated", await request("PATCH", `${roots.autopilot}/${identity}`, nonempty(input), signal), signal, identity);
  }, true);
  tool("manage_autopilot_schedule", "Add, update or remove a schedule trigger. Creating requires a cron_expression and explicit IANA timezone. Only schedule triggers are managed here; webhook secrets are not exposed.", { autopilot_id: id, action: z.enum(["create", "update", "remove"]), trigger_id: id.optional(), cron_expression: z.string().min(1).max(256).optional(), timezone: z.string().min(1).max(100).optional(), enabled: z.boolean().optional(), label: short.optional() }, async ({ autopilot_id, action, trigger_id, ...input }, signal) => {
    const current = await ensure("autopilot", autopilot_id, signal);
    const triggers = Array.isArray(current.triggers) ? rows(current.triggers) : [];
    if (action === "create") {
      if (!input.cron_expression || !input.timezone) throw new Error("A new schedule requires cron_expression and timezone");
      if (input.enabled === false) throw new Error("Create the schedule, then disable it with update");
      delete input.enabled;
      return receipt("autopilot", "schedule_created", await request("POST", `${roots.autopilot}/${autopilot_id}/triggers`, { ...input, kind: "schedule" }, signal), signal, autopilot_id);
    }
    if (!trigger_id || !triggers.some((trigger) => trigger.id === trigger_id && trigger.kind === "schedule")) throw new Error("Schedule trigger not found in this automation");
    const value = await request(action === "remove" ? "DELETE" : "PATCH", `${roots.autopilot}/${autopilot_id}/triggers/${trigger_id}`, action === "remove" ? undefined : nonempty(input), signal);
    return receipt("autopilot", `schedule_${action}`, value, signal, autopilot_id);
  }, true);
  tool("manage_autopilot_webhook", "Create, update or remove an automation's generic/GitHub event trigger. Event scopes use event and optional actions. Webhook URLs, tokens and signing secrets are omitted; copy/configure them in the application rather than exposing them to a model.", { autopilot_id: id, action: z.enum(["create", "update", "remove"]), trigger_id: id.optional(), provider: z.enum(["generic", "github"]).optional(), event_filters: z.array(z.object({ event: short, actions: z.array(short).max(100).optional() }).strict()).max(100).optional(), enabled: z.boolean().optional(), label: short.optional() }, async ({ autopilot_id, action, trigger_id, ...input }, signal) => {
    const current = await ensure("autopilot", autopilot_id, signal); const base = `${roots.autopilot}/${autopilot_id}/triggers`;
    if (action === "create") {
      if (input.enabled !== undefined) throw new Error("Set enabled with update after creating the trigger");
      return receipt("autopilot", "webhook_created", await request("POST", base, { ...input, kind: "webhook" }, signal), signal, autopilot_id);
    }
    if (!trigger_id || !rows(current.triggers).some((trigger) => trigger.id === trigger_id && trigger.kind === "webhook")) throw new Error("Webhook trigger not found in this automation");
    if (input.provider !== undefined) throw new Error("The provider of an existing trigger cannot be changed");
    return receipt("autopilot", `webhook_${action}`, await request(action === "remove" ? "DELETE" : "PATCH", `${base}/${trigger_id}`, action === "remove" ? undefined : nonempty(input), signal), signal, autopilot_id);
  }, true);
  tool("trigger_autopilot", "Run an automation once now. This may create tasks and consume the assigned agent's model quota.", { id }, async ({ id: identity }, signal) => {
    await ensure("autopilot", identity, signal); return receipt("autopilot", "triggered", await request("POST", `${roots.autopilot}/${identity}/trigger`, {}, signal), signal, identity);
  }, true);
  tool("autopilot_runs", "Read execution history for an automation, or details for one of its runs. Follow next_offset for older runs.", { id, run_id: id.optional(), ...paging }, async ({ id: identity, run_id, ...page }, signal) => {
    await ensure("autopilot", identity, signal);
    const value = await get(run_id ? `${roots.autopilot}/${identity}/runs/${run_id}` : query(`${roots.autopilot}/${identity}/runs`, page), signal);
    if (run_id) return value;
    const items = rows(Array.isArray(value) ? value : row(value).runs), more = items.length === page.limit;
    return { items, has_more: more, next_offset: more ? page.offset + items.length : null };
  });

  tool("list_inbox", "Read the current user's inbox in the current workspace.", {}, (_, signal) => get("/api/inbox", signal));
  tool("update_inbox_item", "Mark an inbox notification read/unread, or archive/unarchive it.", { id, action: z.enum(["read", "unread", "archive", "unarchive"]) }, async ({ id: identity, action }, signal) => {
    const inbox = rows(await get(action === "unarchive" ? "/api/inbox/archived" : "/api/inbox", signal));
    if (!inbox.some((entry) => entry.id === identity && (!entry.workspace_id || entry.workspace_id === options.workspaceId))) throw new Error("Inbox item not found in this workspace");
    await request("POST", `/api/inbox/${identity}/${action}`, {}, signal); return { id: identity, action, workspace_id: options.workspaceId };
  }, true);

  const local = async <M extends LocalMethod>(method: M, params: LocalConversationMethods[M]["params"]) => {
    if (!options.local) throw new Error("Local conversation actions are unavailable in this execution");
    return options.local.request(method, params);
  };
  tool("create_conversation", "Create a local Codex/Claude Code conversation or an official cloud chat with a defined Multica agent. Does not send a message. Local project grouping and cloud project_id use the current workspace.", { source: localSource, title: short.optional(), provider: z.enum(["codex", "claude"]).optional(), agent_id: id.optional(), project_id: optionalId }, async ({ source, title, provider, agent_id, project_id }, signal) => {
    if (project_id) await ensure("project", project_id, signal);
    if (source === "local") {
      if (!provider) throw new Error("Choose a local provider: codex or claude");
      const value = await local("create", { provider, title, projectId: project_id });
      return { source, id: value.id, title: value.title, project_id: value.projectId, provider: value.provider };
    }
    if (!agent_id) throw new Error("Cloud conversations require a defined agent_id");
    await ensure("agent", agent_id, signal);
    return receipt("conversation", "created", await request("POST", roots.conversation, { agent_id, title: title ?? "", project_id }, signal), signal);
  }, true);
  tool("update_conversation", "Rename, pin, archive/unarchive, or regroup a saved conversation. Local and cloud histories remain distinct. Cannot archive the conversation currently executing this tool.", { source: localSource, id, title: short.optional(), pinned: z.boolean().optional(), archived: z.boolean().optional(), project_id: optionalId }, async ({ source, id: identity, ...input }, signal) => {
    if (input.archived && identity === options.conversationId) throw new Error("Cannot archive the currently executing conversation");
    if (input.project_id) await ensure("project", input.project_id, signal);
    nonempty(input);
    if (source === "local") {
      const { project_id, ...rest } = input;
      const value = await local("update", { id: identity, ...rest, ...(project_id !== undefined ? { projectId: project_id } : {}) });
      return { source, id: value.id, title: value.title, pinned: value.pinned, archived: value.archived, project_id: value.projectId };
    }
    await ensure("conversation", identity, signal);
    if (input.project_id !== undefined) throw new Error("The official chat API does not support moving an existing chat to another project");
    if (input.title !== undefined) await request("PATCH", `${roots.conversation}/${identity}`, { title: input.title }, signal);
    if (input.pinned !== undefined) await request("PATCH", `${roots.conversation}/${identity}/pin`, { pinned: input.pinned }, signal);
    if (input.archived !== undefined) await request("PATCH", `${roots.conversation}/${identity}/archive`, { archived: input.archived }, signal);
    return receipt("conversation", "updated", await ensure("conversation", identity, signal), signal);
  }, true);
  tool("fork_conversation", "Fork a saved local conversation through a settled turn. The new conversation retains its source lineage. Omit turn_id to fork the full settled history; a running selected turn cannot be forked. Native state may fall back to explicitly labelled saved context.", { id, turn_id: id.optional() }, async ({ id: identity, turn_id }, signal, requestId) => {
    signal.throwIfAborted(); const value = await local("fork", { id: identity, turnId: turn_id, requestId });
    return { source: "local", id: value.id, title: value.title, forked_from: value.forkedFrom, forked_from_turn_id: value.forkedFromTurnId, fork_mode: value.forkMode, provider: value.provider };
  }, true);
  tool("create_side_conversation", "Create a saved Side conversation from a local source conversation/turn, optionally quoting a passage. Does not submit a message or start a model. Side panel presentation is handled by the app.", { id, turn_id: id.optional(), quote: z.string().max(8000).optional() }, async ({ id: identity, turn_id, quote }, signal, requestId) => {
    const previous = (await local("list", {})).find((entry) => entry.side?.requestId === requestId);
    if (previous?.side && (previous.side.sourceId !== identity || previous.side.turnId !== turn_id || previous.side.quote !== quote)) throw new Error("This request_id belongs to a different Side boundary");
    signal.throwIfAborted(); const value = await local("sideCreate", { id: identity, turnId: turn_id, quote, requestId: requestId! });
    return { id: value.id, title: value.title, source_id: value.side?.sourceId, source_turn_id: value.side?.turnId, provider: value.provider };
  }, true);
  tool("list_conversation_branches", "Find saved local conversations, Forks and Side conversations by their source ID. Use the returned IDs with read_context or update_conversation; native provider session IDs are not exposed.", { source_id: id.optional() }, async ({ source_id }, signal) => {
    signal.throwIfAborted(); const list = await local("list", {});
    return { items: list.filter((entry) => !source_id || entry.id === source_id || entry.forkedFrom === source_id || entry.side?.sourceId === source_id).map((entry) => ({ id: entry.id, title: entry.title, provider: entry.provider, archived: entry.archived, project_id: entry.projectId, forked_from: entry.forkedFrom, forked_from_turn_id: entry.forkedFromTurnId, side_source_id: entry.side?.sourceId, side_source_turn_id: entry.side?.turnId })) };
  });
  tool("send_conversation_message", "Send a user-requested message to another saved conversation. Starts model execution and may consume quota. Cannot send into the local conversation currently executing this tool. Read local output with read_execution/read_context, official output with run_messages/read_context.", { source: localSource, id, content: text.min(1), model: z.string().max(200).optional() }, async ({ source, id: identity, content, model }, signal, requestId) => {
    if (source === "local") {
      if (identity === options.conversationId) throw new Error("Cannot recursively send into the current conversation");
      signal.throwIfAborted(); const result = await local("send", { id: identity, content, model, requestId });
      return { source, conversation_id: identity, message_id: result.messageId, turn_id: result.turnId, status: "submitted" };
    }
    await ensure("conversation", identity, signal); return { source, conversation_id: identity, ...row(await request("POST", `${roots.conversation}/${identity}/messages`, { content, ...(model ? { model } : {}) }, signal)) };
  }, true);
  tool("cancel_local_conversation_run", "Cancel a user-selected execution in another local conversation. Does not stop a runtime or the conversation currently executing this MCP tool.", { conversation_id: id, turn_id: id }, async ({ conversation_id, turn_id }, signal) => {
    if (conversation_id === options.conversationId) throw new Error("Cannot cancel the execution currently serving this tool");
    signal.throwIfAborted(); const result = await local("cancel", { id: conversation_id, turnId: turn_id });
    return { conversation_id, turn_id: result.id, status: result.status };
  }, true);

  tool("invoke_agent", "Invoke a defined Multica agent in an official cloud chat, optionally continuing its session. Returns conversation and execution IDs, not a completed answer. Use conversation_runs and run_messages/read_context to obtain progress and results. Reading an agent definition alone does not invoke it.", { agent_id: id, content: text.min(1), session_id: id.optional(), model: z.string().max(200).optional() }, async ({ agent_id, content, session_id, model }, signal) => {
    await ensure("agent", agent_id, signal);
    let session: Row;
    if (session_id) {
      session = await ensure("conversation", session_id, signal);
      if (session.agent_id !== agent_id) throw new Error("Conversation belongs to a different agent");
    } else session = row(await request("POST", roots.conversation, { agent_id, title: content.slice(0, 80) }, signal));
    const identity = id.parse(session.id);
    try {
      const result = row(await request("POST", `${roots.conversation}/${identity}/messages`, { content, ...(model ? { model } : {}) }, signal));
      if (!id.safeParse(result.task_id).success) throw new Error("The server did not confirm an execution ID");
      return { conversation_id: identity, ...result, status: "submitted", note: "Submission is not completion. Poll conversation_runs, then read_context or run_messages." };
    } catch (error) { throw new Error(`Conversation ${identity} exists, but execution submission was not confirmed. Read it before retrying. ${error instanceof Error ? error.message : ""}`); }
  }, true);
  tool("conversation_runs", "Read actual queued/running/completed executions for an official chat, including parallel agent recipients. Follow next_cursor with before. Does not invoke a model.", { session_id: id, limit: z.number().int().min(1).max(100).default(25), before: z.string().max(4096).optional() }, async ({ session_id, ...page }, signal) => {
    await ensure("conversation", session_id, signal);
    const value = await get(query(`${roots.conversation}/${session_id}/tasks`, page), signal);
    return Array.isArray(value) ? { items: rows(value), has_more: false, next_cursor: null } : value;
  });
  tool("run_messages", "Read saved observable output for a specific official execution. Supply its owning conversation or task; runs_before locates older run-list pages. Continue message pages with next_seq as since_seq. Internal thinking is omitted.", { run_id: id, conversation_id: id.optional(), task_id: id.optional(), runs_before: z.string().max(4096).optional(), limit: z.number().int().min(1).max(100).default(50), since_seq: z.number().int().min(0).default(0) }, async ({ run_id, conversation_id, task_id, runs_before, limit, since_seq }, signal) => {
    await ensureRun(run_id, conversation_id, task_id, runs_before, signal);
    const all = rows(await get(query(`/api/tasks/${run_id}/messages`, { since: since_seq }), signal)).filter((entry) => entry.type !== "thinking");
    const items = all.slice(0, limit), more = all.length > items.length;
    return { items, has_more: more, next_seq: more ? items.at(-1)?.seq ?? null : null };
  });
  tool("cancel_run", "Cancel an official agent execution at the user's request. Supply its owning conversation or task, and runs_before for an older run-list page. This does not manage or stop its runtime.", { run_id: id, conversation_id: id.optional(), task_id: id.optional(), runs_before: z.string().max(4096).optional() }, async ({ run_id, conversation_id, task_id, runs_before }, signal) => {
    await ensureRun(run_id, conversation_id, task_id, runs_before, signal);
    await request("POST", `/api/tasks/${run_id}/cancel`, {}, signal); return { id: run_id, status: "cancellation_requested", workspace_id: options.workspaceId };
  }, true);
  tool("delete_workspace_item", "Delete a task, project, squad, Skill, automation or official chat only when the user explicitly requests deletion. Read first and supply its exact current title/name. Agents use reversible archive_agent instead. Deletion can be permanent.", { kind: z.enum(["task", "project", "squad", "skill", "autopilot", "conversation"]), id, expected_name: short }, async ({ kind, id: identity, expected_name }, signal) => {
    const value = await ensure(kind, identity, signal);
    if ((value.title ?? value.name) !== expected_name) throw new Error("The current name does not match; read the resource again before deleting");
    await request("DELETE", `${roots[kind]}/${identity}`, undefined, signal);
    return receipt(kind, "deleted", { id: identity }, signal);
  }, true, true);
  return tools;
}
