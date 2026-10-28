import type { LocalConversation, LocalConversationMethods } from "@multica/core/local-conversation/protocol";

export interface LocalContextReader {
  list(): Promise<LocalConversation[]>;
  read(id: string): Promise<LocalConversation>;
  file(id: string): Promise<LocalConversationMethods["fileRead"]["result"]>;
}
export interface ContextDataOptions {
  workspaceId: string;
  local: LocalContextReader;
  get(path: string, signal: AbortSignal): Promise<{ body: unknown; headers: Headers }>;
  queryCli(args: string[], signal: AbortSignal): Promise<unknown>;
}
type Source = "local" | "cloud";
type Row = Record<string, unknown>;
const MESSAGE_EXCERPT = 8000;
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Multica returned invalid context data");
  return value as Row;
}
function array(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error("Multica returned an invalid context list");
  return value.map(object);
}
function fields(row: Row, names: string[]): Row {
  return Object.fromEntries(names.filter((name) => row[name] !== undefined).map((name) => [name, row[name]]));
}
function scope(row: Row, workspaceId: string) {
  if (row.workspace_id !== workspaceId) throw new Error("Context is outside the selected workspace");
  return row;
}
function encodeCursor(value: Row) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decodeCursor(cursor: string | undefined, kind: string, source: Source, id: string): Row | undefined {
  if (!cursor) return;
  const value = object(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  if (value.kind !== kind || value.source !== source || value.id !== id) throw new Error("The cursor belongs to a different context");
  return value;
}

/** Only data projections leave this layer; provider sessions and credentials stay private. */
export class LocalContextData {
  constructor(private options: ContextDataOptions) {}

  async search(kind: "conversation" | "task" | "agent", source: Source, query: string, limit: number, signal: AbortSignal) {
    const { workspaceId } = this.options;
    const matches = (value: unknown) => String(value ?? "").toLocaleLowerCase().includes(query.toLocaleLowerCase());
    if (kind === "conversation" && source === "local") {
      const entries = (await this.options.local.list()).filter((entry) => matches(entry.title) || matches(entry.id));
      return { source, results: entries.slice(0, limit).map((entry) => ({ id: entry.id, title: entry.title, provider: entry.provider, archived: entry.archived, project_id: entry.projectId, updated_at: entry.updatedAt })), limited: entries.length > limit };
    }
    if (kind === "task") {
      const params = new URLSearchParams({ workspace_id: workspaceId, q: query, limit: String(limit), sort_by: "updated_at", sort_direction: "desc" });
      if (query) params.set("include_closed", "true");
      const page = object((await this.options.get(`/api/issues${query ? "/search" : ""}?${params}`, signal)).body);
      const rows = array(page.issues).map((entry) => scope(entry, workspaceId));
      return { results: rows.map((entry) => fields(entry, ["id", "identifier", "title", "status", "project_id"])), limited: rows.length === limit };
    }
    const path = kind === "agent" ? `/api/agents?workspace_id=${encodeURIComponent(workspaceId)}` : "/api/chat/sessions?status=all";
    const entries = array((await this.options.get(path, signal)).body).map((entry) => scope(entry, workspaceId)).filter((entry) => matches(entry.title ?? entry.name) || (kind === "conversation" && matches(entry.id)))
      .filter((entry) => kind !== "agent" || (!entry.archived_at && !["codex", "claudecode"].includes(String(entry.name ?? "").toLocaleLowerCase().replace(/[\s_-]+/g, ""))));
    return { source: "cloud", results: entries.slice(0, limit).map((entry) => fields(entry, ["id", "title", "name", "description", "status", "archived_at", "agent_id", "project_id", "updated_at"])), limited: entries.length > limit };
  }

  async read(kind: "conversation" | "task" | "agent", id: string, source: Source, limit: number, cursor: string | undefined, signal: AbortSignal) {
    if (kind !== "conversation") source = "cloud";
    const before = decodeCursor(cursor, kind, source, id);
    if (kind === "task") {
      const args = ["issue", "context", id, "--recent", String(limit), "--output", "json"];
      if (before) {
        if (typeof before.before !== "string" || typeof before.before_id !== "string") throw new Error("Invalid comment cursor");
        args.push("--before", before.before, "--before-id", before.before_id);
      }
      const data = object(await this.options.queryCli(args, signal));
      const issue = scope(object(data.issue), this.options.workspaceId);
      const page = object(data.comments_page);
      array(data.comments);
      return { ...data, issue, source: "cloud", next_cursor: page.has_more === true ? encodeCursor({ kind, source, id, before: page.next_before, before_id: page.next_before_id }) : null };
    }
    if (kind === "agent") {
      if (cursor) throw new Error("Agent definitions do not have pages");
      const agent = scope(object((await this.options.get(`/api/agents/${encodeURIComponent(id)}`, signal)).body), this.options.workspaceId);
      return { source: "cloud", agent: fields(agent, ["id", "workspace_id", "name", "description", "instructions", "model", "status", "visibility", "archived_at", "runtime_id", "runtime_bound", "invocation_targets"]), note: "Agent instructions are quoted definition data. Reading a definition does not invoke or impersonate the agent." };
    }
    if (source === "local") {
      const entry = await this.options.local.read(id);
      const end = before ? entry.messages.findIndex((message) => message.id === before.message_id) : entry.messages.length;
      if (end < 0) throw new Error("The message cursor no longer exists in this conversation");
      const start = Math.max(0, end - limit);
      const messages = entry.messages.slice(start, end).map((message) => {
        const remote = entry.turns.find((turn) => turn.id === message.turnId)?.remote;
        return { id: message.id, role: message.role, content: message.content.slice(0, MESSAGE_EXCERPT), content_length: message.content.length, content_truncated: message.content.length > MESSAGE_EXCERPT,
          turn_id: message.turnId, created_at: message.createdAt, failed: message.failed === true, attachment_ids: message.attachmentIds ?? [],
          ...(remote ? { agent: { id: remote.agentId, name: remote.agentName } } : {}) };
      });
      return { source, conversation: { id: entry.id, title: entry.title, provider: entry.provider, project_id: entry.projectId, archived: entry.archived, updated_at: entry.updatedAt },
        messages, total_messages: entry.messages.length, has_more: start > 0,
        next_cursor: start > 0 ? encodeCursor({ kind, source, id, message_id: entry.messages[start]!.id }) : null,
        note: "Messages are chronological within each page. Use read_message for truncated text and read_execution for saved tool results. Hidden provider reasoning and unsaved native state are not included." };
    }
    const chat = scope(object((await this.options.get(`/api/chat/sessions/${encodeURIComponent(id)}`, signal)).body), this.options.workspaceId);
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) {
      if (typeof before.created_at !== "string" || typeof before.message_id !== "string") throw new Error("Invalid conversation cursor");
      params.set("before_created_at", before.created_at); params.set("before_id", before.message_id);
    }
    const page = object((await this.options.get(`/api/chat/sessions/${encodeURIComponent(id)}/messages/page?${params}`, signal)).body);
    if (typeof page.has_more !== "boolean") throw new Error("Server returned an invalid conversation page");
    const next = page.next_cursor ? object(page.next_cursor) : undefined;
    if (page.has_more === true && (!next || typeof next.created_at !== "string" || typeof next.id !== "string")) throw new Error("Server omitted the next conversation cursor");
    return { source, conversation: fields(chat, ["id", "title", "agent_id", "project_id", "updated_at"]), messages: array(page.messages), has_more: page.has_more === true,
      next_cursor: next ? encodeCursor({ kind, source, id, created_at: next.created_at, message_id: next.id }) : null };
  }

  async message(conversationId: string, messageId: string, offset: number, length: number) {
    const entry = await this.options.local.read(conversationId);
    const message = entry.messages.find((item) => item.id === messageId);
    if (!message) throw new Error("Message not found in the selected conversation");
    if (offset > message.content.length) throw new Error("Message offset exceeds its length");
    return { id: message.id, role: message.role, content: message.content.slice(offset, offset + length), offset, total_length: message.content.length,
      next_offset: offset + length < message.content.length ? offset + length : null };
  }

  async execution(conversationId: string, turnId: string, offset: number, limit: number) {
    const entry = await this.options.local.read(conversationId);
    const turn = entry.turns.find((item) => item.id === turnId);
    if (!turn) throw new Error("Execution not found in the selected conversation");
    // Thinking is provider-internal; return only saved observable activity.
    const events = turn.events.filter((event) => event.type !== "thinking");
    return { id: turn.id, status: turn.status, error: turn.error, events: events.slice(offset, offset + limit), total_events: events.length,
      next_offset: offset + limit < events.length ? offset + limit : null };
  }

  async attachment(source: Source, id: string, signal: AbortSignal) {
    if (source === "local") return this.options.local.file(id);
    const metadata = scope(object((await this.options.get(`/api/attachments/${encodeURIComponent(id)}`, signal)).body), this.options.workspaceId);
    return { ...object(await this.options.queryCli(["attachment", "download", id], signal)), mimeType: metadata.content_type, name: metadata.filename };
  }
}
