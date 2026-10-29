// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalConversation } from "@multica/core/local-conversation/protocol";
import { LocalConversationService } from "./local-conversation-service";

const fault = vi.hoisted(() => ({ failIndex: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    if (fault.failIndex && String(args[1]).endsWith("/index.json")) throw new Error("Index commit unavailable");
    return fs.rename(...args);
  } };
});

const scope = { userId: "user", workspaceId: "workspace" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { fault.failIndex = false; for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(count: number) {
  const root = await mkdtemp(join(tmpdir(), "multica-pagination-"));
  const key = createHash("sha256").update(JSON.stringify(["https://example.test", scope.userId, scope.workspaceId])).digest("hex");
  const dir = join(root, key); await mkdir(dir);
  const entries: LocalConversation[] = Array.from({ length: count }, (_, index) => ({
    id: `session-${String(index).padStart(3, "0")}`, title: `Conversation ${index}`, provider: "codex", cwd: "/project", pinned: false, archived: false, model: null,
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
    messages: [{ id: `message-${index}`, role: "assistant", content: `Preview ${index}`, turnId: `turn-${index}`, createdAt: "2026-01-01" }],
    turns: [{ id: `turn-${index}`, status: "completed", createdAt: "2026-01-01", events: [{ seq: 1, type: "text", content: "PRIVATE HISTORY", created_at: "2026-01-01" }] }],
  }));
  const legacy = JSON.stringify({ schemaVersion: 1, sessions: entries, folderProjects: [{ id: "project", title: "Project", path: "/project", createdAt: "2026-01-01" }] });
  await writeFile(join(dir, "conversations.json"), legacy);
  const options = { root, apiUrl: "https://example.test", notify: vi.fn(), chooseDirectory: async () => null, find: async () => "/test/fake-cli" };
  const service = new LocalConversationService(options); service.setCurrentUser(scope.userId);
  cleanups.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { service, options, dir, entries, legacy };
}

it.each([0, 8, 9, 16, 17])("fetches %i conversations in explicit batches of eight", async (count) => {
  const { service } = await fixture(count);
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const page = await service.request(scope, "listPage", { folderProjectId: "project", cursor });
    expect(page.sessions).toHaveLength(Math.min(8, count - ids.length));
    expect(page.sessions.every((entry) => entry.turns.every((turn) => !turn.events.length))).toBe(true);
    ids.push(...page.sessions.map((entry) => entry.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(ids).size).toBe(count);
});

it("keeps a continuation stable when an already loaded conversation is reordered", async () => {
  const { service } = await fixture(17);
  const first = await service.request(scope, "listPage", { folderProjectId: "project" });
  await service.request(scope, "update", { id: "session-016", pinned: true });
  const next = await service.request(scope, "listPage", { folderProjectId: "project", cursor: first.nextCursor! });
  expect(next.sessions).toHaveLength(8);
  expect(next.sessions.some((entry) => first.sessions.some((previous) => previous.id === entry.id))).toBe(false);
  const last = await service.request(scope, "listPage", { folderProjectId: "project", cursor: next.nextCursor! });
  expect(last.sessions.map((entry) => entry.id)).toEqual(["session-016"]);
  await expect(service.request({ ...scope, workspaceId: "other" }, "listPage", { folderProjectId: "project", cursor: first.nextCursor! })).rejects.toThrow();
});

it("keeps legacy history intact if migration cannot commit, then retries safely", async () => {
  const { service, dir, legacy } = await fixture(9);
  fault.failIndex = true;
  await expect(service.request(scope, "listPage", { folderProjectId: "project" })).rejects.toThrow("Index commit unavailable");
  expect(await readFile(join(dir, "conversations.json"), "utf8")).toBe(legacy);
  await expect(readFile(join(dir, "index.json"))).rejects.toMatchObject({ code: "ENOENT" });
  fault.failIndex = false;
  const page = await service.request(scope, "listPage", { folderProjectId: "project" });
  expect(page.sessions).toHaveLength(8);
  expect((await service.request(scope, "read", { id: "session-008" })).turns[0]?.events[0]?.content).toBe("PRIVATE HISTORY");
});

it("migrates once without losing history and lists after restart without opening detail files", async () => {
  const { service, options, dir, legacy } = await fixture(17);
  await service.request(scope, "listPage", { folderProjectId: "project" });
  await service.stop();
  expect(await readFile(join(dir, "conversations.json"), "utf8")).toBe(legacy);
  const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  // Removing an unloaded detail makes any accidental eager read observable.
  const last = index.sessions.find((entry: { summary: LocalConversation }) => entry.summary.id === "session-016");
  const detailPath = join(dir, "details", last.file);
  const saved = await readFile(detailPath, "utf8"); await rm(detailPath);
  const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId);
  cleanups.unshift(() => reopened.stop());
  const first = await reopened.request(scope, "listPage", { folderProjectId: "project" });
  expect(first.sessions).toHaveLength(8);
  expect(await reopened.request(scope, "runtimeState", {})).toEqual({ pendingTasks: [], movedQueueRequests: [] });
  await expect(reopened.request(scope, "read", { id: "session-016" })).rejects.toThrow();
  await writeFile(detailPath, saved);
  expect((await reopened.request(scope, "read", { id: "session-016" })).turns[0]?.events[0]?.content).toBe("PRIVATE HISTORY");
});
