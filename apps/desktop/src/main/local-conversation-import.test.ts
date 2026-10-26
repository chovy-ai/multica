// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalConversationService } from "./local-conversation-service";
import { LocalConversationImport } from "./local-conversation-import";
import type { NativeHistoryReader, NativeHistorySession } from "./local-native-history";
import type { LocalConversation } from "@multica/tutti-agent-gui-host/local-protocol";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
const scope = { userId: "test-user", workspaceId: "test-workspace" };
async function temp() { const root = await mkdtemp(join(tmpdir(), "multica-import-")); cleanups.push(() => rm(root, { recursive: true, force: true })); return root; }
function session(id: string, cwd: string): NativeHistorySession {
  return { id, provider: "codex", title: "Native history", cwd, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    messages: [{ id: "message", role: "assistant", content: "Imported answer", turnId: "turn", createdAt: "2026-01-01T00:00:00Z" }], turns: [{ id: "turn", status: "completed", createdAt: "2026-01-01T00:00:00Z", events: [] }] };
}
function setup(root: string, history?: NativeHistoryReader, fork = vi.fn(async () => "independent")) {
  const run = vi.fn(async () => ({ output: "Continued", sessionId: "independent" }));
  const options = { root: join(root, "multica"), apiUrl: "https://test.invalid", notify: vi.fn(), chooseDirectory: async () => null, run, find: vi.fn(async () => "/test/fake-provider"), history, ...(history ? { fork } : {}) };
  const service = new LocalConversationService(options); service.setCurrentUser(scope.userId); cleanups.push(() => service.stop());
  return { service, options, run, fork };
}
describe("native conversation import persistence", () => {
  it("forks real synthetic Claude history, leaves the source intact, deduplicates after reopening and resumes the copy", async () => {
    const root = await temp(), cwd = join(root, "project"), config = join(root, "claude"); await mkdir(cwd);
    vi.stubEnv("CLAUDE_CONFIG_DIR", config);
    const folder = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); await mkdir(folder, { recursive: true });
    const id = randomUUID(), first = randomUUID();
    const original = [
      { type: "user", uuid: first, parentUuid: null, sessionId: id, cwd, isSidechain: false, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Original question" } },
      { type: "assistant", uuid: randomUUID(), parentUuid: first, sessionId: id, cwd, isSidechain: false, timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Private reasoning" }, { type: "text", text: "```svg\n<svg/>\n```" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const path = join(folder, `${id}.jsonl`); await writeFile(path, original);
    const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    expect(await getSessionMessages(id)).toHaveLength(2);
    const { service, options, run } = setup(root);
    expect((await service.request(scope, "importScan", { provider: "claude" })).sessions).toContainEqual(expect.objectContaining({ id, cwd }));
    const imported = await service.request(scope, "importSessions", { provider: "claude", ids: [id, id], projectId: "project-a" });
    expect(imported.failed).toEqual([]); expect(imported.imported).toHaveLength(1);
    const entry = await service.request(scope, "read", { id: imported.imported[0]!.conversationId });
    expect(entry).toMatchObject({ importedFrom: { provider: "claude", sessionId: id }, projectId: "project-a", cwd });
    expect(entry.providerSessionId).not.toBe(id); expect(entry.messages).toHaveLength(2);
    expect(entry.messages.at(-1)?.content).toContain("```svg"); expect(JSON.stringify(entry)).not.toContain("Private reasoning");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(run).not.toHaveBeenCalled(); await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId); cleanups.push(() => reopened.stop());
    const repeated = await reopened.request(scope, "importSessions", { provider: "claude", ids: [id] });
    expect(repeated.skipped).toHaveLength(1); expect(repeated.imported).toEqual([]);
    expect((await reopened.request(scope, "importScan", { provider: "claude" })).sessions.find((value) => value.id === id)?.importedId).toBe(entry.id);
    await reopened.request(scope, "send", { id: entry.id, content: "Continue" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ resume: entry.providerSessionId, cwd, provider: "claude", content: "Continue" }), expect.any(Function), expect.any(AbortSignal)));
    expect(await readFile(path, "utf8")).toBe(original);
  });
  it("keeps successful imports when another source fails and validates native identifiers", async () => {
    const root = await temp();
    const history = { list: vi.fn(async () => ({ sessions: [], nextCursor: null })), read: vi.fn(async (_provider, id) => { if (id === "broken") throw new Error("Unreadable history"); return session(id, root); }) } satisfies NativeHistoryReader;
    const { service, fork } = setup(root, history);
    const pending = service.request(scope, "importSessions", { provider: "codex", ids: ["good", "broken"] });
    await vi.waitFor(() => expect(history.read).toHaveBeenCalled());
    const result = await pending;
    expect(result.imported).toHaveLength(1); expect(result.failed).toEqual([{ sourceId: "broken", error: "Unreadable history" }]);
    expect(fork).toHaveBeenCalledOnce();
    expect((await service.request(scope, "list", {}))).toHaveLength(1);
    await expect(service.request(scope, "importSessions", { provider: "codex", ids: ["--help"] })).rejects.toThrow(/valid native/);
  });
  it("serializes imports in one workspace so concurrent requests cannot create duplicate branches", async () => {
    const root = await temp(), rows = new Map<string, LocalConversation>(), fork = vi.fn(async () => "copy");
    const importer = new LocalConversationImport({ rows: async () => rows, assertCurrent: () => {}, save: async () => {}, notify: vi.fn(),
      history: { list: async () => ({ sessions: [], nextCursor: null }), read: async (_provider, id) => session(id, root) }, fork });
    const first = importer.import(scope, "codex", ["source"], null);
    await expect(importer.import(scope, "codex", ["source"], null)).rejects.toThrow(/already running/);
    expect((await first).imported).toHaveLength(1);
    expect((await importer.import(scope, "codex", ["source"], null)).skipped).toHaveLength(1);
    expect(fork).toHaveBeenCalledOnce(); await importer.stop();
  });
  it("cancels an import on account change and never persists another account's history", async () => {
    const root = await temp();
    const history: NativeHistoryReader = { list: async () => ({ sessions: [], nextCursor: null }), read: (_provider, _id, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true })) };
    const { service, fork } = setup(root, history);
    const operation = service.request(scope, "importSessions", { provider: "codex", ids: ["source"] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    service.setCurrentUser("other"); await expect(operation).rejects.toThrow(); expect(fork).not.toHaveBeenCalled();
    service.setCurrentUser(scope.userId); expect(await service.request(scope, "list", {})).toEqual([]);
  });
  it("does not leave a phantom local conversation after a failed save", async () => {
    const root = await temp(), rows = new Map<string, LocalConversation>();
    const importer = new LocalConversationImport({ rows: async () => rows, assertCurrent: () => {}, save: async () => { throw new Error("Disk full"); }, notify: vi.fn(),
      history: { list: async () => ({ sessions: [], nextCursor: null }), read: async (_provider, id) => session(id, root) }, fork: async () => "copy" });
    expect((await importer.import(scope, "codex", ["source"], null)).failed).toEqual([{ sourceId: "source", error: "Disk full" }]);
    expect(rows.size).toBe(0); await importer.stop();
  });
});
