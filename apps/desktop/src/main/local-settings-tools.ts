import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SETTINGS_DOMAINS, SETTINGS_OPERATIONS, type SettingsScope, type SettingsRequest } from "@multica/core/settings/operations";
import type { WorkspaceMcpTool } from "./local-workspace-tools";
import { publicSettingsValue, SettingsOperationError } from "../shared/settings-operation-error";

export interface SettingsHostRequest { operation: string; scope: SettingsScope; input: Record<string, unknown> }
export interface SettingsToolOptions extends SettingsScope {
  root: string;
  cloudAvailable: boolean;
  request(request: SettingsRequest, signal: AbortSignal): Promise<unknown>;
  host?: (request: SettingsHostRequest, signal: AbortSignal) => Promise<unknown>;
  confirm?: (request: SettingsHostRequest & { impact?: unknown }, signal: AbortSignal) => Promise<boolean>;
  showSecret?: (name: string, secret: string, scope: SettingsScope, signal: AbortSignal) => Promise<void>;
}
type Row = Record<string, unknown>;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const flights = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

function checkWorkspace(value: unknown, scope: SettingsScope) {
  if (Array.isArray(value)) { value.forEach((entry) => checkWorkspace(entry, scope)); return; }
  if (!value || typeof value !== "object") return;
  const row = value as Row;
  if (row.workspace_id && row.workspace_id !== scope.workspaceId) throw new SettingsOperationError("workspace_mismatch", "The response belongs to another workspace");
  for (const entry of Object.values(row)) if (typeof entry === "object") checkWorkspace(entry, scope);
}
function includesId(value: unknown, id: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => includesId(entry, id));
  const row = object(value);
  return row.id === id || Object.values(row).some((entry) => Array.isArray(entry) && includesId(entry, id));
}

/** Write-ahead receipts survive execution retries. Unknown outcomes stay blocked, never replayed. */
async function writeOnce(options: SettingsToolOptions, operation: string, requestId: string, input: Row, run: () => Promise<unknown>) {
  const fingerprint = digest({ operation, input });
  const path = join(options.root, digest([options.workspaceId, options.userId, operation, requestId]) + ".json");
  const active = flights.get(path);
  if (active) {
    if (active.fingerprint !== fingerprint) throw new SettingsOperationError("request_id_conflict", "This request_id belongs to different input");
    return active.result;
  }
  const result = (async () => {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    const metadata = { operation, request_id: requestId, user_id: options.userId, workspace_id: options.workspaceId, created_at: new Date().toISOString() };
    try {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ ...metadata, fingerprint, status: "pending" })); await file.sync(); }
      finally { await file.close(); }
    } catch (error) {
      if (object(error).code !== "EEXIST") throw error;
      const saved = object(JSON.parse(await readFile(path, "utf8")));
      if (saved.fingerprint !== fingerprint) throw new SettingsOperationError("request_id_conflict", "This request_id belongs to different input");
      if (saved.status === "completed") return saved.result;
      if (saved.status === "rejected") { const error = object(saved.error); throw new SettingsOperationError(String(error.code), String(error.message), error.details, Number(error.http_status)); }
      throw new SettingsOperationError("operation_outcome_unknown", "This operation was already attempted. Read current settings before choosing a new request_id; the previous write will not be replayed.");
    }
    let value: unknown;
    try { value = await run(); }
    catch (error) {
      if (error instanceof SettingsOperationError && error.status && error.status >= 400 && error.status < 500) {
        const temporary = `${path}.rejected`;
        await writeFile(temporary, JSON.stringify({ ...metadata, fingerprint, status: "rejected", error: error.toJSON() }), { mode: 0o600 });
        await rename(temporary, path);
      }
      throw error;
    }
    const temporary = `${path}.complete`;
    await writeFile(temporary, JSON.stringify({ ...metadata, fingerprint, status: "completed", result: value }), { mode: 0o600 });
    await rename(temporary, path);
    return value;
  })();
  flights.set(path, { fingerprint, result });
  try { return await result; } finally { flights.delete(path); }
}

export function createSettingsTools(options: SettingsToolOptions): WorkspaceMcpTool[] {
  const scope = { workspaceId: options.workspaceId, userId: options.userId };
  const available = SETTINGS_OPERATIONS.filter((operation) => (operation.request ? options.cloudAvailable : Boolean(options.host)) && (operation.name !== "settings_create_token" || Boolean(options.showSecret)));
  const tools: WorkspaceMcpTool[] = [{
    name: "settings_capabilities",
    description: "Discover Settings operations for this execution, account, workspace and device. Permission hints are not authorization; the server evaluates resource ownership and feature gates on every call.",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    call: async (_, signal) => {
      let role = "unknown";
      if (options.cloudAvailable) {
        const members = await options.request({ method: "GET", path: `/api/workspaces/${scope.workspaceId}/members` }, signal);
        checkWorkspace(members, scope);
        const member = Array.isArray(members) ? members.map(object).find((entry) => entry.user_id === scope.userId) : undefined;
        if (typeof member?.role === "string") role = member.role;
      }
      return { workspace_id: scope.workspaceId, user_id: scope.userId, role, cloud_available: options.cloudAvailable, confirmation_available: Boolean(options.confirm), feature_gates: { project_workflows_v1: "server_evaluated" }, domains: SETTINGS_DOMAINS, operations: available.map(({ name, domain, write, confirm, permission }) => ({ name, domain, write, human_confirmation: confirm, permission, authorization: permission === "admin" && role !== "unknown" ? ["owner", "admin"].includes(role) ? "eligible" : "denied" : "server_or_host_evaluated" })) };
    },
  }];
  for (const operation of available) {
    const inputSchema: z.ZodRawShape = { ...operation.schema, ...(operation.write ? { request_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/) } : {}) };
    const schema = z.object(inputSchema).strict();
    const execute = async (input: Row, signal: AbortSignal) => {
      signal.throwIfAborted();
      const hostRequest = { operation: operation.name, scope, input };
      let before: unknown;
      if (operation.before) {
        before = await options.request(operation.before(scope, input), signal);
        if (operation.domain !== "profile") checkWorkspace(before, scope);
        if (["settings_update_workspace", "settings_update_code_settings"].includes(operation.name) && object(before).id !== scope.workspaceId) throw new SettingsOperationError("workspace_mismatch", "The setting belongs to another workspace");
        if (operation.domain === "profile" && object(before).id !== scope.userId) throw new SettingsOperationError("account_mismatch", "The profile belongs to another account");
        if (input.id && !includesId(before, input.id)) throw new SettingsOperationError("resource_not_found", "The setting is outside this workspace or is no longer available");
      }
      let impact: unknown;
      if (operation.name === "settings_update_workflow") {
        impact = await options.request({ ...operation.request!(scope, input), body: { ...object(input.fields), dry_run: true } }, signal);
      }
      if (operation.name === "settings_set_project_workflow" && input.dry_run === false) {
        impact = await options.request({ ...operation.request!(scope, input), body: { workflow_id: input.workflow_id, status_mapping: input.status_mapping, dry_run: true } }, signal);
      }
      const preview = input.dry_run === true || (operation.name === "settings_device_action" && input.action === "check_update");
      const needsConfirmation = !preview && (operation.confirm || Number(object(object(impact).plan).affected_issues) > 0);
      if (needsConfirmation) {
        if (!options.confirm) throw new SettingsOperationError("confirmation_unavailable", "This action requires the desktop confirmation UI");
        if (!await options.confirm({ ...hostRequest, impact: publicSettingsValue(impact ?? before) }, signal)) return { status: "cancelled", operation: operation.name, workspace_id: scope.workspaceId };
        signal.throwIfAborted();
      }
      if (!operation.request) return options.host!(hostRequest, signal);
      const request = operation.request(scope, input);
      if (operation.name === "settings_update_code_settings") request.body = { settings: { ...object(object(before).settings), ...object(input.fields) } };
      const raw = await options.request(request, signal);
      signal.throwIfAborted();
      if (operation.domain !== "profile" && operation.domain !== "tokens") checkWorkspace(raw, scope);
      if (operation.name === "settings_read_workspace" && object(raw).id !== scope.workspaceId) throw new SettingsOperationError("workspace_mismatch", "The setting belongs to another workspace");
      if (operation.domain === "profile" && object(raw).id !== scope.userId) throw new SettingsOperationError("account_mismatch", "The profile belongs to another account");
      if (["settings_create_workflow", "settings_create_status", "settings_create_label", "settings_create_property", "settings_create_quick_action", "settings_create_mcp_server"].includes(operation.name)) {
        if (typeof object(raw).id !== "string" || !object(raw).id || (operation.domain !== "mcp" && object(raw).workspace_id !== scope.workspaceId)) throw new SettingsOperationError("result_unconfirmed", "The server did not confirm a created resource in this workspace. Read current settings before another creation.");
      }
      if (operation.name === "settings_create_token") {
        const result = object(raw);
        if (typeof result.token !== "string" || !result.token) throw new SettingsOperationError("result_unconfirmed", "The server did not confirm token creation");
        if (!options.showSecret) throw new SettingsOperationError("secret_display_unavailable", "The token was created but could not be displayed. Revoke it in Settings; do not create another token automatically.");
        await options.showSecret(String(input.name), result.token, scope, signal);
        return { status: "applied", operation: operation.name, id: result.id ?? null, secret_displayed_to_user: true };
      }
      if (operation.name === "settings_list_tokens") {
        const values = Array.isArray(raw) ? raw : object(raw).tokens;
        if (!Array.isArray(values)) throw new SettingsOperationError("invalid_response", "The token metadata response is invalid");
        return values.map((entry) => { const row = object(entry); return { id: row.id, name: row.name, prefix: row.token_prefix, expires_at: row.expires_at, last_used_at: row.last_used_at, created_at: row.created_at }; });
      }
      const mcpSummary = (entry: unknown) => { const row = object(entry); return { id: row.id, name: row.name, transport: row.transport }; };
      const value = operation.domain === "mcp" ? Array.isArray(raw) ? raw.map(mcpSummary) : mcpSummary(raw) : publicSettingsValue(raw);
      let uiRefresh: string | undefined;
      if (operation.write && !preview && options.host) {
        try { await options.host({ operation: "settings_refresh", scope, input: {} }, signal); uiRefresh = "refreshed"; }
        catch { uiRefresh = "pending"; }
      }
      return operation.write && !preview ? { status: "applied", operation: operation.name, workspace_id: scope.workspaceId, data: value, settings_tab: operation.domain, ...(uiRefresh ? { ui_refresh: uiRefresh } : {}) } : value;
    };
    tools.push({
      name: operation.name, description: operation.description, inputSchema,
      annotations: { readOnlyHint: !operation.write, destructiveHint: operation.confirm, idempotentHint: !operation.write, openWorldHint: false },
      call: async (raw, signal) => {
        const { request_id, ...input } = schema.parse(raw);
        if (!operation.write || input.dry_run === true || (operation.name === "settings_device_action" && input.action === "check_update")) return execute(input, signal);
        return writeOnce(options, operation.name, String(request_id), input, () => execute(input, signal));
      },
    });
  }
  return tools;
}
