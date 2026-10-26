import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { LocalConversationScope } from "@multica/tutti-agent-gui-host/local-protocol";
import type { LocalTimingRecord } from "@multica/tutti-agent-gui-host/local-timing";
import type { DeveloperLogQuery, DeveloperLogSaveResult } from "../shared/developer-logs";
import type { WorkspaceMcpTool } from "./local-workspace-tools";
import { LocalTimingLog } from "./local-timing-log";

const querySchema = z.object({
  sinceMinutes: z.number().int().min(1).max(10080),
  conversationId: z.string().regex(/^[\w:.-]{1,160}$/).optional(),
}).strict();
const exportFilename = /^multica-developer-logs-[\dTZ-]+-[\da-f-]+\.json$/;
const retentionMs = 7 * 24 * 60 * 60 * 1000;

interface RuntimeInfo {
  appVersion: string;
  platform: string;
  arch: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  packaged: boolean;
}
interface Options {
  log: LocalTimingLog;
  exportsRoot: string;
  runtime: RuntimeInfo;
  assertScope(scope: LocalConversationScope): void;
  conversations(scope: LocalConversationScope): Promise<string[]>;
  chooseSavePath(filename: string): Promise<string | null>;
}

function summarize(records: LocalTimingRecord[]) {
  const stages = new Map<string, { stage: string; records: number; waits: number; maxDurationMs?: number }>();
  for (const record of records) {
    const stage = stages.get(record.stage) ?? { stage: record.stage, records: 0, waits: 0 };
    stage.records++;
    if (record.event === "wait") stage.waits++;
    if (record.durationMs !== undefined) stage.maxDurationMs = Math.max(stage.maxDurationMs ?? 0, record.durationMs);
    stages.set(record.stage, stage);
  }
  return {
    recordCount: records.length,
    conversationCount: new Set(records.map((record) => record.conversationId)).size,
    turnCount: new Set(records.flatMap((record) => record.turnId ? [record.turnId] : [])).size,
    failureCount: records.filter((record) => record.failure !== undefined).length,
    stages: [...stages.values()],
  };
}

/** Both export entry points use the same bounded, account/workspace-scoped snapshot. */
export class DeveloperLogExporter {
  constructor(private options: Options) {}

  private async bundle(scope: LocalConversationScope, input: DeveloperLogQuery, signal: AbortSignal) {
    const query = querySchema.parse(input);
    signal.throwIfAborted(); this.options.assertScope(scope);
    const ids = await this.options.conversations(scope);
    this.options.assertScope(scope); signal.throwIfAborted();
    if (query.conversationId && !ids.includes(query.conversationId)) throw new Error("Conversation is unavailable in the current workspace");
    const until = Date.now();
    const since = until - query.sinceMinutes * 60_000;
    const { records, incomplete } = await this.options.log.snapshot(new Set(query.conversationId ? [query.conversationId] : ids), since, until);
    this.options.assertScope(scope); signal.throwIfAborted();
    return {
      schemaVersion: 1,
      exportedAt: new Date(until).toISOString(),
      runtime: this.options.runtime,
      workspaceId: scope.workspaceId,
      filter: { since: new Date(since).toISOString(), until: new Date(until).toISOString(), conversationId: query.conversationId ?? null },
      coverage: { incomplete, retainedFiles: 2, maxFileBytes: 5 * 1024 * 1024, historicalLogsMayHaveRotated: true },
      summary: summarize(records),
      records,
    };
  }

  private filename() { return `multica-developer-logs-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}.json`; }

  async save(scope: LocalConversationScope): Promise<DeveloperLogSaveResult> {
    const signal = new AbortController().signal;
    const bundle = await this.bundle(scope, { sinceMinutes: 1440 }, signal);
    const path = await this.options.chooseSavePath(this.filename());
    this.options.assertScope(scope);
    if (!path) return { status: "cancelled" };
    const temporary = join(dirname(path), `.multica-logs-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      this.options.assertScope(scope);
      await rename(temporary, path);
    } catch { throw new Error("Could not save developer logs"); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
    return { status: "saved", filename: basename(path), recordCount: bundle.summary.recordCount };
  }

  async export(scope: LocalConversationScope, query: DeveloperLogQuery, signal: AbortSignal) {
    const bundle = await this.bundle(scope, query, signal);
    const path = join(this.options.exportsRoot, this.filename());
    try {
      await mkdir(this.options.exportsRoot, { recursive: true, mode: 0o700 });
      this.options.assertScope(scope); signal.throwIfAborted();
      await writeFile(path, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      this.options.assertScope(scope); signal.throwIfAborted();
    } catch {
      await rm(path, { force: true }).catch(() => undefined);
      throw new Error(signal.aborted ? "Developer log export cancelled" : "Could not export developer logs");
    }
    await this.prune().catch(() => undefined);
    return { path, format: "json", ...bundle.summary, incomplete: bundle.coverage.incomplete, filter: bundle.filter };
  }

  private async prune() {
    const files = await Promise.all((await readdir(this.options.exportsRoot)).filter((name) => exportFilename.test(name)).map(async (name) => ({ path: join(this.options.exportsRoot, name), modified: (await stat(join(this.options.exportsRoot, name))).mtimeMs })));
    files.sort((a, b) => b.modified - a.modified);
    await Promise.all(files.filter((file, index) => index >= 20 || Date.now() - file.modified > retentionMs).map((file) => rm(file.path, { force: true })));
  }
}

export function createDeveloperLogTool(exporter: DeveloperLogExporter, scope: LocalConversationScope, currentConversationId?: string): WorkspaceMcpTool {
  const requests = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  const inputSchema = {
    scope: z.enum(["conversation", "workspace"]).default("conversation"),
    conversation_id: z.string().regex(/^[\w:.-]{1,160}$/).optional(),
    since_minutes: z.number().int().min(1).max(10080).default(60),
    request_id: z.string().trim().min(1).max(128),
  };
  return {
    name: "export_developer_logs",
    description: "Export retained local developer timing logs and runtime versions to a private JSON file. Defaults to this conversation and the last 60 minutes; scope=workspace includes only this account's selected workspace. No cloud login is required. Returns a local path and stage summary; read the file with a native file tool. Does not include message text, tool payloads, images, credentials or raw provider logs. Use when the user requests diagnostics, reuse request_id on retries, and never upload the file without the user's request. Local exports are kept for up to 7 days, at most 20 files.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async call(raw, signal) {
      const input = z.object(inputSchema).strict().parse(raw);
      if (input.scope === "workspace" && input.conversation_id) throw new Error("Omit conversation_id for a workspace export");
      const conversationId = input.scope === "conversation" ? input.conversation_id ?? currentConversationId : undefined;
      if (input.scope === "conversation" && !conversationId) throw new Error("Supply a local conversation_id or choose scope=workspace");
      const query = { sinceMinutes: input.since_minutes, ...(conversationId ? { conversationId } : {}) };
      const fingerprint = JSON.stringify(query);
      const previous = requests.get(input.request_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("This request_id already belongs to another log export");
        return previous.result;
      }
      if (requests.size >= 20) throw new Error("Too many log exports in this execution");
      const result = exporter.export(scope, query, signal);
      requests.set(input.request_id, { fingerprint, result });
      return result;
    },
  };
}
