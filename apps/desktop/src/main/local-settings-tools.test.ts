// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSettingsTools, type SettingsToolOptions } from "./local-settings-tools";
import { settingsHttpError } from "./settings-operation-error";
import { startLocalContextMcp } from "./local-context-mcp";
import { LocalContextData } from "./local-context-data";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(overrides: Partial<SettingsToolOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "settings-mcp-")); roots.push(root);
  const request = vi.fn(async ({ method, path, body }) => {
    if (path.endsWith("/members")) return [{ id: "membership", user_id: "user", role: "admin", workspace_id: "workspace" }];
    if (path === "/api/workspaces/workspace") return method === "GET" ? { id: "workspace", settings: { unrelated: "retained", github_enabled: true } } : { id: "workspace", workspace_id: "workspace", ...body };
    if (path === "/api/issue-workflows/flow") {
      if (method === "GET") return { id: "flow", workspace_id: "workspace", name: "Delivery", project_ids: ["project"] };
      if (body?.dry_run) return { dry_run: true, plan: { affected_issues: 4, total_issues: 20, required: [], unchanged: [] } };
      return { id: "flow", workspace_id: "workspace", ...body };
    }
    if (path === "/api/projects/project") return { id: "project", workspace_id: "workspace" };
    if (path === "/api/projects/project/workflow") return body.dry_run ? { dry_run: true, plan: { affected_issues: 0 } } : { id: "project", workspace_id: "workspace" };
    if (path.startsWith("/api/properties/")) return { id: "property", workspace_id: "workspace", config: { options: [{ id: "existing", name: "Existing", color: "#111111" }] } };
    if (path === "/api/tokens") return method === "GET" ? [{ id: "pat", name: "Test", token_prefix: "mul_x", token: "DO-NOT-EXPOSE" }] : { id: "pat", token: "DO-NOT-EXPOSE" };
    if (path === "/api/me") return { id: "user", ...body };
    if (method === "POST") return { id: "created", workspace_id: "workspace", ...body };
    return { id: "target", workspace_id: "workspace", ...body };
  });
  const confirm = vi.fn(async () => true), host = vi.fn(async () => ({ status: "applied" })), showSecret = vi.fn(async () => {});
  const options: SettingsToolOptions = { root, workspaceId: "workspace", userId: "user", cloudAvailable: true, request, confirm, host, showSecret, ...overrides };
  const tools = createSettingsTools(options);
  const call = (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.call(input, new AbortController().signal);
  };
  return { root, options, request, confirm, host, showSecret, tools, call };
}

describe("execution-scoped Settings capabilities", () => {
  it("discovers scope and role while hiding unavailable cloud and secret-display operations", async () => {
    const f = await fixture();
    expect(await f.call("settings_capabilities")).toMatchObject({ user_id: "user", workspace_id: "workspace", role: "admin", feature_gates: { project_workflows_v1: "server_evaluated" } });
    const offline = createSettingsTools({ ...f.options, cloudAvailable: false });
    expect(offline.map((entry) => entry.name)).toContain("settings_update_device");
    expect(offline.map((entry) => entry.name)).not.toContain("settings_create_workflow");
    expect(createSettingsTools({ ...f.options, showSecret: undefined }).map((entry) => entry.name)).not.toContain("settings_create_token");
    expect(f.tools.every((entry) => entry.name.startsWith("settings_"))).toBe(true);
  });

  it("previews exact workflow edits before confirmation and retains server mapping fields", async () => {
    const f = await fixture();
    const fields = { steps: [{ status_key: "todo" }, { status_key: "done" }], status_mapping: { qa: "done" } };
    expect(await f.call("settings_update_workflow", { id: "flow", fields, request_id: "change-flow" })).toMatchObject({ status: "applied" });
    expect(f.request.mock.calls.map(([r]) => r.method)).toEqual(["GET", "PATCH", "PATCH"]);
    expect(f.request.mock.calls[1]?.[0].body).toEqual({ ...fields, dry_run: true });
    expect(f.request.mock.calls[2]?.[0].body).toEqual({ ...fields, dry_run: false });
    expect(f.confirm).toHaveBeenCalledWith(expect.objectContaining({ impact: { dry_run: true, plan: { affected_issues: 4, total_issues: 20, required: [], unchanged: [] } } }), expect.any(AbortSignal));
    expect(f.host).toHaveBeenCalledWith(expect.objectContaining({ operation: "settings_refresh" }), expect.any(AbortSignal));
  });

  it("does not confirm or mutate a project-workflow preview", async () => {
    const f = await fixture();
    expect(await f.call("settings_set_project_workflow", { project_id: "project", workflow_id: null, dry_run: true, request_id: "preview" })).toMatchObject({ dry_run: true });
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.request.mock.calls.at(-1)?.[0].body.dry_run).toBe(true);
  });

  it("cancels dangerous writes when a real human declines and never accepts agent-supplied approval", async () => {
    const f = await fixture({ confirm: async () => false });
    expect(await f.call("settings_delete_workflow", { id: "flow", request_id: "delete-flow" })).toMatchObject({ status: "cancelled" });
    expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
    await expect(f.call("settings_delete_workflow", { id: "flow", request_id: "new", approved: true })).rejects.toThrow();
  });

  it("preserves unrelated code settings and uses the atomic status-order endpoint", async () => {
    const f = await fixture();
    await f.call("settings_update_code_settings", { fields: { github_enabled: false }, request_id: "code" });
    expect(f.request.mock.calls.at(-1)?.[0].body).toEqual({ settings: { unrelated: "retained", github_enabled: false } });
    f.request.mockClear();
    await f.call("settings_reorder_statuses", { category: "done", ids: ["first", "second"], request_id: "order" });
    expect(f.request).toHaveBeenCalledExactlyOnceWith({ method: "PATCH", path: "/api/issue-statuses/reorder", body: { category: "done", ids: ["first", "second"], include_system: false } }, expect.any(AbortSignal));
  });

  it("rejects immutable fields, cross-workspace IDs and arbitrary HTTP parameters", async () => {
    const f = await fixture();
    await expect(f.call("settings_update_status", { id: "target", fields: { category: "closed" }, request_id: "bad" })).rejects.toThrow();
    await expect(f.call("settings_update_property", { id: "property", fields: { type: "number" }, request_id: "bad" })).rejects.toThrow();
    await expect(f.call("settings_list_workflows", { path: "https://example.invalid" })).rejects.toThrow();
    await expect(f.call("settings_create_mcp_server", { name: "private", url: "https://user:password@example.test/mcp", request_id: "bad-url" })).rejects.toThrow("credential-bearing");
    const foreign = await fixture({ request: async () => ({ id: "flow", workspace_id: "foreign" }) });
    await expect(foreign.call("settings_delete_workflow", { id: "flow", request_id: "delete" })).rejects.toThrow("another workspace");
    expect(foreign.confirm).not.toHaveBeenCalled();
    await expect(foreign.call("settings_read_workspace")).rejects.toThrow("another workspace");
    await expect(foreign.call("settings_read_profile")).rejects.toThrow("another account");
  });

  it("uses protocol fields language and done, rather than display labels or new enums", async () => {
    const f = await fixture();
    await f.call("settings_update_profile", { fields: { language: "zh-Hans", timezone: "America/Los_Angeles" }, request_id: "profile" });
    expect(f.request.mock.calls.at(-1)?.[0].body).toEqual({ language: "zh-Hans", timezone: "America/Los_Angeles" });
    await expect(f.call("settings_create_status", { name: "QA", category: "completed", color: "#111111", request_id: "status" })).rejects.toThrow();
  });

  it("reuses durable receipts across new tool instances without replaying creation", async () => {
    const f = await fixture();
    const input = { name: "Delivery", request_id: "once" };
    const result = await f.call("settings_create_workflow", input);
    const restarted = createSettingsTools(f.options).find((tool) => tool.name === "settings_create_workflow")!;
    expect(await restarted.call(input, new AbortController().signal)).toEqual(result);
    expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
    await expect(restarted.call({ ...input, name: "Other" }, new AbortController().signal)).rejects.toThrow("different input");
  });

  it("does not repeat an ambiguous network write after the execution restarts", async () => {
    const request = vi.fn(async () => { throw new Error("connection lost"); });
    const f = await fixture({ request });
    const input = { name: "Delivery", request_id: "uncertain" };
    await expect(f.call("settings_create_workflow", input)).rejects.toThrow("connection lost");
    const tool = createSettingsTools(f.options).find((entry) => entry.name === "settings_create_workflow")!;
    await expect(tool.call(input, new AbortController().signal)).rejects.toMatchObject({ code: "operation_outcome_unknown" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not claim creation succeeded without a confirmed resource ID", async () => {
    const f = await fixture({ request: async () => ({ success: true }) });
    await expect(f.call("settings_create_workflow", { name: "Delivery", request_id: "unconfirmed" })).rejects.toMatchObject({ code: "result_unconfirmed" });
  });
  it("keeps property option configuration while stripping credential-bearing MCP configurations", async () => {
    const f = await fixture({ request: async ({ path }) => path === "/api/properties?include_archived=false" ? { properties: [{ id: "property", workspace_id: "workspace", config: { options: [{ id: "option", name: "QA", color: "#111111" }] } }] } : [{ id: "server", name: "Public", transport: "http", config: { command: "private", args: ["PRIVATE"], headers: { Authorization: "PRIVATE" } } }] });
    expect(await f.call("settings_list_properties")).toMatchObject({ properties: [{ config: { options: [{ id: "option", name: "QA" }] } }] });
    expect(JSON.stringify(await f.call("settings_list_mcp_servers"))).not.toContain("PRIVATE");
    expect(await f.call("settings_list_mcp_servers")).toEqual([{ id: "server", name: "Public", transport: "http" }]);
  });

  it("displays new token values only to the human, with no secret in replies or durable receipts", async () => {
    const f = await fixture();
    const result = await f.call("settings_create_token", { name: "Integration", request_id: "pat" });
    expect(f.showSecret).toHaveBeenCalledWith("Integration", "DO-NOT-EXPOSE", { workspaceId: "workspace", userId: "user" }, expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toContain("DO-NOT-EXPOSE");
    const files = await readdir(f.root);
    expect((await Promise.all(files.map((file) => readFile(join(f.root, file), "utf8")))).join("")).not.toContain("DO-NOT-EXPOSE");
    expect(await f.call("settings_list_tokens")).toEqual([{ id: "pat", name: "Test", prefix: "mul_x", expires_at: undefined, last_used_at: undefined, created_at: undefined }]);
  });

  it("keeps an applied server change successful if UI refresh cannot run", async () => {
    const f = await fixture({ host: async () => { throw new Error("workspace changed"); } });
    expect(await f.call("settings_create_workflow", { name: "Flow", request_id: "create" })).toMatchObject({ status: "applied", ui_refresh: "pending" });
  });

  it("preserves structured workflow errors over a real MCP transport without disclosing credentials", async () => {
    const f = await fixture({ request: async () => { throw settingsHttpError(409, { code: "workflow_status_mapping_required", error: "Map tasks TOKEN", plan: { affected_issues: 2, required: [{ status_key: "qa", issue_count: 2 }], access_token: "TOKEN" } }, "TOKEN"); } });
    const controller = new AbortController();
    const server = await startLocalContextMcp(new LocalContextData({ workspaceId: "workspace", local: { list: async () => [], read: async () => { throw new Error("unused"); }, file: async () => { throw new Error("unused"); } }, get: async () => ({ body: null, headers: new Headers() }), queryCli: async () => null }), {}, controller.signal, undefined, f.tools);
    const client = new Client({ name: "settings-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } }));
      expect((await client.listTools()).tools.some((tool) => tool.name === "settings_preview_workflow")).toBe(true);
      const result = await client.callTool({ name: "settings_preview_workflow", arguments: { id: "flow", fields: { name: "QA" } } });
      expect(result.isError).toBe(true);
      const error = JSON.parse((result.content as { text: string }[])[0]!.text);
      expect(error).toMatchObject({ code: "workflow_status_mapping_required", http_status: 409, details: { plan: { affected_issues: 2 } } });
      expect(JSON.stringify(result)).not.toContain("TOKEN");
    } finally { await client.close(); await server.close(); }
  });

  it.runIf(process.env.MULTICA_RUN_SETTINGS_CLI_TEST === "1")("shares the actual MCP registry and durable receipts with a test-built CLI", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const data = new LocalContextData({ workspaceId: "workspace", local: { list: async () => [], read: async () => { throw new Error("unused"); }, file: async () => { throw new Error("unused"); } }, get: async () => ({ body: null, headers: new Headers() }), queryCli: async () => null });
    const server = await startLocalContextMcp(data, {}, controller.signal, undefined, f.tools);
    // Explicit opt-in and a fixed test-owned binary: never resolve the user's installed CLI.
    const binary = fileURLToPath(new URL("../../../../.tmp/settings-mcp-bin/multica", import.meta.url));
    const input = join(f.root, "input.json");
    await writeFile(input, JSON.stringify({ name: "Delivery", request_id: "cli-create" }));
    const env = { ...process.env, MULTICA_SETTINGS_MCP_URL: server.url, MULTICA_CONTEXT_MCP_TOKEN: server.token };
    try {
      const capabilities = await promisify(execFile)(binary, ["settings", "capabilities"], { env });
      expect(JSON.parse(capabilities.stdout)).toMatchObject({ workspace_id: "workspace", role: "admin" });
      const first = await promisify(execFile)(binary, ["settings", "call", "settings_create_workflow", "--input-file", input], { env });
      const second = await promisify(execFile)(binary, ["settings", "call", "settings_create_workflow", "--input-file", input], { env });
      expect(JSON.parse(first.stdout)).toMatchObject({ status: "applied", data: { id: "created" } });
      expect(second.stdout).toBe(first.stdout);
      await writeFile(join(f.root, "mcp.json"), JSON.stringify({ mcpServers: { multica_desktop_context: { url: server.url, headers: { Authorization: `Bearer ${server.token}` } } } }), { mode: 0o600 });
      const filtered = await promisify(execFile)(binary, ["settings", "capabilities"], { env: { ...env, MULTICA_SETTINGS_MCP_URL: "", MULTICA_CONTEXT_MCP_TOKEN: "", MULTICA_TASK_CONFIG_ROOT: f.root } });
      expect(JSON.parse(filtered.stdout)).toMatchObject({ workspace_id: "workspace", role: "admin" });
      expect(f.request.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    } finally { await server.close(); }
  });
});
