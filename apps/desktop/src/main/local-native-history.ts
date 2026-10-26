import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { LocalConversation, LocalConversationEvent, LocalImportCandidate, LocalImportPage, LocalProviderId } from "@multica/tutti-agent-gui-host/local-protocol";
import { findLocalProvider } from "./local-provider-runner";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const items = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const string = (value: unknown): string => typeof value === "string" ? value : "";
const date = (value: unknown, fallback = ""): string => {
  const time = typeof value === "number" ? value : Date.parse(string(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
};
export interface NativeHistorySession extends LocalImportCandidate {
  messages: LocalConversation["messages"]; turns: LocalConversation["turns"];
}
export interface NativeHistoryReader {
  list(provider: LocalProviderId, cursor: string | undefined, signal: AbortSignal): Promise<LocalImportPage>;
  read(provider: LocalProviderId, id: string, signal: AbortSignal): Promise<NativeHistorySession>;
}

/** Only listing and reading RPCs are exposed; this process cannot start a model turn. */
async function codexHistory<T>(executable: string, signal: AbortSignal, read: (call: (method: string, params: Row) => Promise<Row>) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const child = spawn(executable, ["app-server"], { cwd: homedir(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve(value: Row): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let serial = 0, closed = false, bytes = 0;
  const kill = (force = false) => {
    if (!child.pid || child.exitCode !== null) return;
    try { if (process.platform === "win32") child.kill(); else process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* Owned reader exited. */ }
  };
  const stop = (error: Error) => { closed = true; for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error); } pending.clear(); kill(); };
  const abort = () => stop(new Error("History import cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  child.on("error", () => stop(new Error("Could not open the Codex history reader")));
  child.on("close", () => stop(new Error("Codex history reader disconnected")));
  child.stdin.on("error", () => stop(new Error("Codex history reader disconnected")));
  child.stderr.resume();
  lines.on("line", (line) => {
    bytes += Buffer.byteLength(line, "utf8");
    if (bytes > 64 * 1024 * 1024) { stop(new Error("This conversation exceeds the history import size limit")); return; }
    let response: Row; try { response = row(JSON.parse(line)); } catch { return; }
    const request = pending.get(Number(response.id)); if (!request) return;
    clearTimeout(request.timer); pending.delete(Number(response.id));
    if (response.error) request.reject(new Error(string(row(response.error).message) || "Codex cannot read this history"));
    else request.resolve(row(response.result));
  });
  const call = (method: string, params: Row) => new Promise<Row>((resolve, reject) => {
    if (closed || signal.aborted) { reject(new Error("History reader is closed")); return; }
    const id = ++serial;
    const timer = setTimeout(() => { stop(new Error("Codex history query timed out")); }, 20_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await call("initialize", { clientInfo: { name: "multica_history_import", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    return await read(call);
  } finally {
    signal.removeEventListener("abort", abort); stop(new Error("History reader closed")); lines.close();
    const escalation = setTimeout(() => kill(true), 2000); escalation.unref();
  }
}

function codexCandidate(value: Row): LocalImportCandidate {
  const createdAt = date(typeof value.createdAt === "number" ? value.createdAt * 1000 : value.createdAt);
  if (!string(value.id) || !string(value.cwd) || !createdAt) throw new Error("Codex returned invalid session metadata");
  return { id: string(value.id), provider: "codex", title: (string(value.name) || string(value.preview) || "Codex").slice(0, 256), cwd: string(value.cwd), createdAt,
    updatedAt: date(typeof value.updatedAt === "number" ? value.updatedAt * 1000 : value.updatedAt, createdAt) };
}
function textBlocks(value: unknown): string {
  if (typeof value === "string") return value;
  return items(value).map((block) => block.type === "text" || block.type === "input_text" || block.type === "output_text" ? string(block.text)
    : ["image", "localImage", "input_image"].includes(string(block.type)) ? "[Image retained in native session context]" : "").filter(Boolean).join("\n");
}
function event(turn: LocalConversation["turns"][number], value: Omit<LocalConversationEvent, "seq" | "created_at">) { turn.events.push({ ...value, seq: turn.events.length + 1, created_at: turn.createdAt }); }
export function projectCodexHistory(metadata: LocalImportCandidate, turns: Row[]): NativeHistorySession {
  const result: NativeHistorySession = { ...metadata, messages: [], turns: [] };
  for (const source of turns) {
    if (source.itemsView === "notLoaded" || source.itemsView === "summary") throw new Error("Codex returned incomplete history; update Codex and retry");
    const at = date(typeof source.startedAt === "number" ? source.startedAt * 1000 : source.startedAt, metadata.createdAt);
    const turn: LocalConversation["turns"][number] = { id: randomUUID(), status: source.status === "failed" ? "failed" : source.status === "interrupted" || source.status === "inProgress" ? "cancelled" : "completed", createdAt: at, events: [] };
    for (const item of items(source.items)) {
      const content = item.type === "userMessage" ? textBlocks(item.content) : item.type === "agentMessage" ? string(item.text) : "";
      if (content) result.messages.push({ id: randomUUID(), role: item.type === "userMessage" ? "user" : "assistant", content, turnId: turn.id, createdAt: at });
      if (item.type === "commandExecution") {
        event(turn, { type: "tool_use", tool: "Bash", input: { command: string(item.command) }, call_id: string(item.id) });
        event(turn, { type: "tool_result", tool: "Bash", output: string(item.aggregatedOutput), call_id: string(item.id) });
      } else if (item.type === "mcpToolCall") {
        const tool = `mcp__${string(item.server)}__${string(item.tool)}`;
        event(turn, { type: "tool_use", tool, input: row(item.arguments), call_id: string(item.id) });
        event(turn, { type: "tool_result", tool, output: JSON.stringify(item.error ?? item.result ?? {}), call_id: string(item.id) });
      }
    }
    result.turns.push(turn);
  }
  return result;
}

export class LocalNativeHistory implements NativeHistoryReader {
  constructor(private find = findLocalProvider) {}
  private async codex<T>(signal: AbortSignal, read: Parameters<typeof codexHistory<T>>[2]) {
    const executable = await this.find("codex"); if (!executable) throw new Error("Codex is not installed on this computer");
    return codexHistory(executable, signal, read);
  }
  async list(provider: LocalProviderId, cursor: string | undefined, signal: AbortSignal): Promise<LocalImportPage> {
    signal.throwIfAborted();
    if (provider === "codex") return this.codex(signal, async (call) => {
      let archived = false, nativeCursor: string | undefined;
      if (cursor) {
        let decoded: Row;
        try { decoded = row(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); } catch { throw new Error("Invalid Codex history cursor"); }
        if (typeof decoded.archived !== "boolean" || (decoded.cursor != null && typeof decoded.cursor !== "string")) throw new Error("Invalid Codex history cursor");
        archived = decoded.archived; nativeCursor = string(decoded.cursor) || undefined;
      }
      const page = await call("thread/list", { limit: 50, sortKey: "updated_at", useStateDbOnly: true, archived, sourceKinds: ["cli", "vscode", "appServer", "exec"], ...(nativeCursor ? { cursor: nativeCursor } : {}) });
      if (!Array.isArray(page.data) || (page.nextCursor != null && typeof page.nextCursor !== "string")) throw new Error("Codex returned an invalid history page");
      const next = page.nextCursor ? { archived, cursor: page.nextCursor } : !archived ? { archived: true, cursor: null } : null;
      return { sessions: items(page.data).filter((entry) => !entry.ephemeral).map(codexCandidate), nextCursor: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : null };
    });
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid Claude history cursor");
    const { listSessions } = await import("@anthropic-ai/claude-agent-sdk");
    const sessions = await listSessions({ limit: 50, offset }); signal.throwIfAborted();
    return { sessions: sessions.filter((entry) => entry.cwd).map((entry) => ({ id: entry.sessionId, provider: "claude", title: (entry.customTitle || entry.summary || entry.firstPrompt || "Claude Code").slice(0, 256), cwd: entry.cwd!, createdAt: date(entry.createdAt, date(entry.lastModified)), updatedAt: date(entry.lastModified) })), nextCursor: sessions.length === 50 ? String(offset + 50) : null };
  }
  async read(provider: LocalProviderId, id: string, signal: AbortSignal): Promise<NativeHistorySession> {
    signal.throwIfAborted();
    if (provider === "codex") return this.codex(signal, async (call) => {
      const thread = row((await call("thread/read", { threadId: id })).thread);
      if (thread.id !== id) throw new Error("Codex history not found");
      const metadata = codexCandidate(thread), turns: Row[] = [], cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await call("thread/turns/list", { threadId: id, limit: 50, sortDirection: "asc", itemsView: "full", ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page.data) || (page.nextCursor != null && typeof page.nextCursor !== "string")) throw new Error("Codex returned an invalid turn page");
        turns.push(...items(page.data)); cursor = string(page.nextCursor) || undefined;
        if (cursor && cursors.has(cursor)) throw new Error("Codex returned a repeated history cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return projectCodexHistory(metadata, turns);
    });
    const { getSessionInfo, getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    const info = await getSessionInfo(id); signal.throwIfAborted();
    if (!info?.cwd) throw new Error("Claude Code history or its working directory is unavailable");
    if ((info.fileSize ?? 0) > 64 * 1024 * 1024) throw new Error("This conversation exceeds the history import size limit");
    const at = date(info.createdAt, date(info.lastModified));
    const result: NativeHistorySession = { id, provider, title: (info.customTitle || info.summary || info.firstPrompt || "Claude Code").slice(0, 256), cwd: info.cwd, createdAt: at, updatedAt: date(info.lastModified), messages: [], turns: [] };
    // Resolve by the discovered UUID: directory canonicalization can differ from the stored project key.
    const messages = await getSessionMessages(id); signal.throwIfAborted();
    let turn: LocalConversation["turns"][number] | undefined;
    for (const source of messages) {
      const message = row(source.message), content = textBlocks(message.content);
      const timestamp = date(row(source).timestamp, at);
      if (!turn || (source.type === "user" && content)) { turn = { id: randomUUID(), status: "completed", createdAt: timestamp, events: [] }; result.turns.push(turn); }
      if (content && (source.type === "user" || source.type === "assistant")) result.messages.push({ id: randomUUID(), role: source.type, content, turnId: turn.id, createdAt: timestamp });
      for (const block of items(message.content)) {
        if (block.type === "tool_use") event(turn, { type: "tool_use", tool: string(block.name), input: row(block.input), call_id: string(block.id) });
        if (block.type === "tool_result") event(turn, { type: "tool_result", output: textBlocks(block.content), call_id: string(block.tool_use_id) });
      }
    }
    return result;
  }
}
