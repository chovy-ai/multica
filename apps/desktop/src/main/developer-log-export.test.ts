// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { LocalTimingLog } from "./local-timing-log";
import { WebDiagnosticLog, snapshotDaemonLog } from "./developer-runtime-logs";
import { DeveloperLogExporter, createDeveloperLogTool } from "./developer-log-export";

const scope = { userId: "user", workspaceId: "workspace" };
const signal = () => new AbortController().signal;
const runtime = { appVersion: "test-version", platform: "darwin", arch: "arm64", electronVersion: "test", chromeVersion: "test", nodeVersion: "test", packaged: false };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "multica-export-"));
  const log = new LocalTimingLog(root);
  const selected = join(root, "selected.json");
  const webLog = new WebDiagnosticLog(root, "https://test.invalid", scope.userId);
  const daemonPath = join(root, "daemon.log");
  let active = true;
  const options = {
    log, exportsRoot: join(root, "exports"), runtime,
    assertScope: () => { if (!active) throw new Error("Account is no longer active"); },
    conversations: vi.fn(async () => ["conversation", "second"]),
    runtimeLogs: vi.fn(async (_scope: typeof scope, since: number, until: number) => ({ web: await webLog.snapshot(since, until), daemon: await snapshotDaemonLog(daemonPath) })),
    chooseSavePath: vi.fn(async (): Promise<string | null> => selected),
  };
  const now = Date.now();
  const record = { version: 1, source: "main", stage: "provider.first_text", event: "mark", elapsedMs: 42, at: new Date(now).toISOString(), conversationId: "conversation", turnId: "turn", requestId: "request", provider: "codex", message: "NEVER_EXPORT", env: { token: "NEVER_EXPORT" } };
  for (const value of [record, { ...record, conversationId: "second" }, { ...record, conversationId: "foreign" }, { ...record, at: new Date(now - 2 * 86400000).toISOString() }]) log.write(value);
  return { root, log, webLog, daemonPath, selected, options, exporter: new DeveloperLogExporter(options), deactivate: () => { active = false; }, cleanup: async () => { await log.flush(); await webLog.flush(); await rm(root, { recursive: true, force: true }); } };
}

describe("developer log export", () => {
  it("shares a sanitized, scoped snapshot between native save and MCP exports", async () => {
    const f = await fixture();
    try {
      const saved = await f.exporter.save(scope);
      const ui = JSON.parse(await readFile(f.selected, "utf8"));
      expect(saved).toEqual({ status: "saved", filename: "selected.json", recordCount: 2 });
      expect(ui.runtime.appVersion).toBe("test-version");
      expect(ui.records.map((record: { conversationId: string }) => record.conversationId)).toEqual(["conversation", "second"]);
      const exported = await f.exporter.export(scope, { sinceMinutes: 60, conversationId: "conversation" }, signal());
      const contents = await readFile(exported.path, "utf8");
      expect(exported.recordCount).toBe(1);
      expect(JSON.parse(contents).records[0]).toMatchObject({ turnId: "turn", stage: "provider.first_text" });
      expect(contents).not.toMatch(/NEVER_EXPORT|foreign|message|env/);
      expect(exported.stages).toEqual([{ stage: "provider.first_text", background: false, records: 1, waits: 0 }]);
      if (process.platform !== "win32") {
        expect((await stat(exported.path)).mode & 0o777).toBe(0o600);
        expect((await stat(f.selected)).mode & 0o777).toBe(0o600);
      }
    } finally { await f.cleanup(); }
  });
  it("separates background timings and exports duration percentiles through both entry points", async () => {
    const f = await fixture();
    try {
      for (const background of [false, true]) for (const durationMs of [10, 20, 100]) f.log.write({
        version: 1, source: "main", conversationId: "conversation", turnId: "turn", at: new Date().toISOString(),
        stage: "context.dispose", event: "end", elapsedMs: 100, durationMs, background,
      });
      const exported = await f.exporter.export(scope, { sinceMinutes: 60 }, signal());
      await f.exporter.save(scope);
      const saved = JSON.parse(await readFile(f.selected, "utf8"));
      expect(exported.stages).toEqual(saved.summary.stages);
      expect(exported.stages.filter((stage) => stage.stage === "context.dispose")).toEqual([false, true].map((background) => ({
        stage: "context.dispose", background, records: 3, waits: 0, samples: 3, p50DurationMs: 20, p95DurationMs: 100, maxDurationMs: 100,
      })));
      const bundle = JSON.parse(await readFile(exported.path, "utf8"));
      expect(bundle.records.filter((record: { background?: boolean }) => record.background)).toHaveLength(3);
    } finally { await f.cleanup(); }
  });
  it("includes Web and daemon logs in the same UI and MCP bundle with honest source coverage", async () => {
    const f = await fixture();
    try {
      f.webLog.console({ level: "error", message: "fetch failed token=NEVER_EXPORT" });
      await writeFile(f.daemonPath, "12:34:56.789 ERR connection failed token=NEVER_EXPORT\n");
      await f.exporter.save(scope);
      const ui = JSON.parse(await readFile(f.selected, "utf8"));
      const result = await createDeveloperLogTool(f.exporter, scope, "conversation").call({ request_id: "combined" }, signal()) as { path: string };
      const mcp = JSON.parse(await readFile(result.path, "utf8"));
      for (const bundle of [ui, mcp]) {
        expect(bundle.schemaVersion).toBe(2);
        expect(bundle.sources.web).toMatchObject({ status: "available", scope: "account", timeFilterApplied: true, records: [{ level: "error", message: "fetch failed token=[REDACTED]" }] });
        expect(bundle.sources.daemon).toMatchObject({ status: "available", scope: "desktop-profile", timeFilterApplied: false, text: expect.stringContaining("connection failed") });
        expect(bundle.summary).toMatchObject({ webRecordCount: 1, daemonLineCount: 1 });
        expect(bundle.summary.recordCount).toBe(bundle.summary.timingRecordCount + 2);
        expect(JSON.stringify(bundle)).not.toContain("NEVER_EXPORT");
      }
      expect(mcp.records).toHaveLength(1);
      expect(ui.records).toHaveLength(2);
      await rm(f.daemonPath);
      const absent = await f.exporter.export(scope, { sinceMinutes: 60 }, signal());
      expect(absent.sources.daemon.status).toBe("missing");
    } finally { await f.cleanup(); }
  });
  it("still saves Web and timing records when the daemon source cannot be read", async () => {
    const f = await fixture();
    try {
      f.webLog.console({ level: "info", message: "Web ready" });
      await mkdir(f.daemonPath);
      await f.exporter.save(scope);
      const bundle = JSON.parse(await readFile(f.selected, "utf8"));
      expect(bundle.sources.web.status).toBe("available");
      expect(bundle.sources.daemon.status).toBe("unreadable");
      expect(bundle.coverage.incomplete).toBe(true);
      expect(bundle.records).toHaveLength(2);
    } finally { await f.cleanup(); }
  });
  it("rejects account changes while collecting runtime sources before saving", async () => {
    const f = await fixture();
    try {
      const readSources = f.options.runtimeLogs.getMockImplementation()!;
      f.options.runtimeLogs.mockImplementationOnce(async (...args) => {
        const sources = await readSources(...args);
        f.deactivate();
        return sources;
      });
      await expect(f.exporter.save(scope)).rejects.toThrow("Account is no longer active");
      expect(f.options.chooseSavePath).not.toHaveBeenCalled();
      expect(await readdir(f.root)).not.toContain("selected.json");
    } finally { await f.cleanup(); }
  });
  it("does not save when cancelled or when the account changes in the save dialog", async () => {
    const f = await fixture();
    try {
      f.options.chooseSavePath.mockResolvedValueOnce(null);
      expect(await f.exporter.save(scope)).toEqual({ status: "cancelled" });
      expect(await readdir(f.root)).not.toContain("selected.json");
      f.options.chooseSavePath.mockImplementationOnce(async () => { f.deactivate(); return f.selected; });
      await expect(f.exporter.save(scope)).rejects.toThrow("Account is no longer active");
      expect(await readdir(f.root)).not.toContain("selected.json");
    } finally { await f.cleanup(); }
  });
  it("rejects foreign conversations, out-of-range filters and cancelled calls before writing", async () => {
    const f = await fixture();
    try {
      await expect(f.exporter.export(scope, { sinceMinutes: 60, conversationId: "foreign" }, signal())).rejects.toThrow("unavailable");
      await expect(f.exporter.export(scope, { sinceMinutes: 10081 }, signal())).rejects.toThrow();
      await expect(f.exporter.export(scope, { sinceMinutes: 60 }, AbortSignal.abort())).rejects.toThrow();
      expect(await readdir(f.root)).not.toContain("exports");
    } finally { await f.cleanup(); }
  });
  it("keeps the save destination intact and reports a failure when saving cannot finish", async () => {
    const f = await fixture();
    try {
      f.options.chooseSavePath.mockResolvedValue(join(f.root, "missing", "out.json"));
      await expect(f.exporter.save(scope)).rejects.toThrow("Could not save developer logs");
      expect((await readdir(f.root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally { await f.cleanup(); }
  });
  it("returns an honest empty snapshot and bounds automatically generated files", async () => {
    const f = await fixture();
    try {
      const empty = await f.exporter.export(scope, { sinceMinutes: 60, conversationId: "second" }, signal());
      const old = new Date(Date.now() - 8 * 86400000);
      await utimes(empty.path, old, old);
      await writeFile(join(f.options.exportsRoot, "keep-me.txt"), "unrelated");
      f.options.conversations.mockResolvedValue([]);
      for (let index = 0; index < 22; index++) {
        const result = await f.exporter.export(scope, { sinceMinutes: 60 }, signal());
        expect(result.recordCount).toBe(0);
      }
      const files = await readdir(f.options.exportsRoot);
      expect(files.filter((name) => name.endsWith(".json"))).toHaveLength(20);
      expect(files).toContain("keep-me.txt");
      await expect(stat(empty.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.cleanup(); }
  });
  it("defaults MCP to the current conversation, deduplicates retries and permits explicit workspace export", async () => {
    const f = await fixture();
    try {
      const tool = createDeveloperLogTool(f.exporter, scope, "conversation");
      const input = { request_id: "same-export" };
      const [first, retry] = await Promise.all([tool.call(input, signal()), tool.call(input, signal())]);
      expect(first).toEqual(retry);
      expect(first).toMatchObject({ recordCount: 1, filter: { conversationId: "conversation" } });
      expect(await readdir(f.options.exportsRoot)).toHaveLength(1);
      await expect(tool.call({ request_id: "same-export", scope: "workspace" }, signal())).rejects.toThrow("another log export");
      expect(await tool.call({ request_id: "all", scope: "workspace" }, signal())).toMatchObject({ recordCount: 2, filter: { conversationId: null } });
      await expect(tool.call({ request_id: "path", path: "/tmp/arbitrary.json" }, signal())).rejects.toThrow();
    } finally { await f.cleanup(); }
  });
});
