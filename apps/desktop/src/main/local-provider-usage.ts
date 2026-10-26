import { spawn } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { LocalAccountUsage, LocalContextUsage, LocalConversation, LocalProviderId, LocalProviderUsage, LocalUsageWindow } from "@multica/tutti-agent-gui-host/local-protocol";
import { findLocalProvider } from "./local-provider-runner";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const emptyContext = (): LocalContextUsage => ({ usedTokens: null, limitTokens: null, model: null, updatedAt: null });
function resetTime(value: unknown): string | null {
  const time = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function window(id: string, label: string, percent: unknown, resets: unknown): LocalUsageWindow | null {
  const used = number(percent);
  return used === null ? null : { id, label, usedPercent: Math.min(100, used), resetsAt: resetTime(resets) };
}

/** Accept only provider-owned numeric fields; never return control envelopes or credentials. */
export function parseAccountUsage(provider: LocalProviderId, value: unknown): LocalAccountUsage {
  const data = record(value);
  const windows: LocalUsageWindow[] = [];
  let plan: string | null = null;
  if (provider === "claude") {
    plan = typeof data.subscription_type === "string" ? data.subscription_type : null;
    const limits = record(data.rate_limits);
    for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]]) {
      const item = record(limits[key]);
      const result = window(key!, label!, item.utilization, item.resets_at);
      if (result) windows.push(result);
    }
    const scoped = Array.isArray(limits.model_scoped) ? limits.model_scoped : [];
    scoped.forEach((raw, index) => {
      const item = record(raw);
      const label = typeof item.display_name === "string" ? item.display_name.slice(0, 80) : "Model";
      const result = window(`model:${index}`, label, item.utilization, item.resets_at);
      if (result) windows.push(result);
    });
  } else {
    const byId = record(data.rateLimitsByLimitId);
    const all = Object.keys(byId).length ? Object.entries(byId) : [["codex", data.rateLimits]];
    for (const [id, raw] of all) {
      const limits = record(raw);
      plan ??= typeof limits.planType === "string" ? limits.planType : null;
      for (const key of ["primary", "secondary"]) {
        const item = record(limits[key]);
        const minutes = number(item.windowDurationMins);
        const duration = minutes === null ? key : minutes >= 1440 ? `${minutes / 1440}d` : `${minutes / 60}h`;
        const label = id === "codex" ? duration : `${String(id).slice(0, 60)} · ${duration}`;
        const result = window(`${id}:${key}`, label, item.usedPercent, item.resetsAt);
        if (result) windows.push(result);
      }
    }
  }
  return { status: windows.length ? "available" : "unavailable", plan, windows, updatedAt: new Date().toISOString() };
}

/** Context is the latest main-conversation request, never the sum of billed turns. */
export function parseContextUsage(provider: LocalProviderId, rows: unknown[], limit: number | null = null): LocalContextUsage {
  let context = emptyContext();
  for (const raw of rows) {
    const row = record(raw);
    if (provider === "claude") {
      if (row.type !== "assistant" || row.isSidechain || row.parent_tool_use_id) continue;
      const message = record(row.message), usage = record(message.usage);
      const input = number(usage.input_tokens);
      if (input === null) continue;
      context = { usedTokens: input + (number(usage.cache_read_input_tokens) ?? 0) + (number(usage.cache_creation_input_tokens) ?? 0),
        limitTokens: limit, model: typeof message.model === "string" ? message.model : null,
        updatedAt: typeof row.timestamp === "string" ? row.timestamp : null };
    } else {
      const payload = record(row.payload), info = record(payload.info), last = record(info.last_token_usage);
      if (row.type !== "event_msg" || payload.type !== "token_count" || number(last.total_tokens) === null) continue;
      context = { usedTokens: number(last.total_tokens), limitTokens: number(info.model_context_window), model: null,
        updatedAt: typeof row.timestamp === "string" ? row.timestamp : null };
    }
  }
  return context;
}

/** Initialization and usage RPCs only: no user prompt, inference, or credential extraction. */
export async function probeProviderUsage(provider: LocalProviderId, executable: string, entry?: LocalConversation, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Usage probe cancelled")); return; }
    const args = provider === "claude"
      ? ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", ...(entry?.providerSessionId ? ["--resume", entry.providerSessionId] : [])]
      : ["app-server"];
    const child = spawn(executable, args, { cwd: entry?.cwd || homedir(), env: process.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const kill = (force = false) => {
      if (!child.pid || child.exitCode !== null) return;
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      } catch { /* The owned probe has already exited. */ }
    };
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); signal?.removeEventListener("abort", cancel); lines.close();
      kill(); const escalation = setTimeout(() => kill(true), 2000); escalation.unref();
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish(new Error("Usage probe cancelled"));
    const timeout = setTimeout(() => finish(new Error("Usage probe timed out")), 20_000);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stderr.resume();
    child.stdin.on("error", () => finish(new Error("Usage probe disconnected")));
    child.on("error", () => finish(new Error("Usage probe unavailable")));
    child.on("close", () => finish(new Error("Usage probe closed before responding")));
    const send = (id: number, method: string, params: RecordValue) => child.stdin.write(JSON.stringify(provider === "claude"
      ? { type: "control_request", request_id: String(id), request: { subtype: method, ...params } }
      : { id, method, params }) + "\n");
    lines.on("line", (line) => {
      let event: RecordValue; try { event = record(JSON.parse(line)); } catch { return; }
      const reply = provider === "claude" ? record(event.response) : event;
      const id = provider === "claude" ? reply.request_id : reply.id;
      if (id !== 1 && id !== 2 && id !== "1" && id !== "2") return;
      if (reply.error || (provider === "claude" && reply.subtype !== "success")) { finish(new Error("Provider does not expose usage")); return; }
      if (String(id) === "1") {
        if (provider === "codex") child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        send(2, provider === "claude" ? "get_usage" : "account/rateLimits/read", provider === "claude" ? { skip_behaviors: true } : {});
      } else finish(undefined, provider === "claude" ? reply.response : reply.result);
    });
    send(1, "initialize", provider === "claude" ? {} : { clientInfo: { name: "multica_usage", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  });
}

interface ReaderOptions {
  find?: typeof findLocalProvider;
  probe?: typeof probeProviderUsage;
  claudeHome?: string; codexHome?: string;
}
export class LocalProviderUsageReader {
  private cache = new Map<string, { at: number; account: LocalAccountUsage; limits: RecordValue }>();
  private pending = new Map<string, Promise<{ account: LocalAccountUsage; limits: RecordValue }>>();
  private paths = new Map<string, string>();
  private controller = new AbortController();
  constructor(private options: ReaderOptions = {}) {}
  reset(): void {
    this.controller.abort(); this.controller = new AbortController(); this.cache.clear(); this.pending.clear(); this.paths.clear();
  }
  private async account(provider: LocalProviderId, entry?: LocalConversation, force = false): Promise<{ account: LocalAccountUsage; limits: RecordValue }> {
    const key = `${provider}:${entry?.providerSessionId ?? "account"}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < (force ? 15_000 : 60_000) && (!force || cached.account.status !== "error")) return cached;
    if (this.pending.has(key)) return this.pending.get(key)!;
    const signal = this.controller.signal;
    const operation = (async () => {
      try {
        const executable = await (this.options.find ?? findLocalProvider)(provider);
        if (!executable) return { account: { status: "unavailable", plan: null, windows: [], updatedAt: null } as LocalAccountUsage, limits: {} };
        const raw = record(await (this.options.probe ?? probeProviderUsage)(provider, executable, entry, signal));
        const value = { at: Date.now(), account: parseAccountUsage(provider, raw), limits: record(record(raw.session).model_usage) };
        if (!signal.aborted) this.cache.set(key, value);
        return value;
      } catch {
        const account: LocalAccountUsage = cached ? { ...cached.account, status: "error", stale: true } : { status: "error", plan: null, windows: [], updatedAt: null };
        const value = { at: Date.now(), account, limits: cached?.limits ?? {} };
        if (!signal.aborted) this.cache.set(key, value);
        return value;
      }
    })().finally(() => { if (this.pending.get(key) === operation) this.pending.delete(key); });
    this.pending.set(key, operation); return operation;
  }
  private async transcript(entry: LocalConversation): Promise<unknown[]> {
    const id = entry.providerSessionId;
    if (!id || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) return [];
    const root = entry.provider === "claude" ? join(this.options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")
      : join(this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
    const key = `${root}:${id}`;
    let path = this.paths.get(key);
    if (!path) {
      const find = async (dir: string, depth: number): Promise<string | undefined> => {
        let children; try { children = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const child of children) if (child.isFile() && child.name.endsWith(`${id}.jsonl`)) return join(dir, child.name);
        if (depth > 0) for (const child of children) if (child.isDirectory()) { const result = await find(join(dir, child.name), depth - 1); if (result) return result; }
        return undefined;
      };
      path = await find(root, entry.provider === "claude" ? 1 : 4);
      if (!path) return []; this.paths.set(key, path);
    }
    const file = await open(path, "r");
    try {
      const size = (await file.stat()).size, length = Math.min(size, 2_000_000), buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      return buffer.toString("utf8").split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    } finally { await file.close(); }
  }
  async read(provider: LocalProviderId, entry?: LocalConversation, force = false): Promise<LocalProviderUsage> {
    const [account, rows] = await Promise.all([this.account(provider, entry, force), entry ? this.transcript(entry).catch(() => []) : Promise.resolve([])]);
    const context = parseContextUsage(provider, rows);
    if (context.model) context.limitTokens = number(record(account.limits[context.model]).contextWindow);
    return { provider, context, account: account.account };
  }
}
