// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalConversationService } from "./local-conversation-service";
import type { LocalCodexPool } from "./local-codex-pool";
import type { LocalProviderId, SideWorkspaceTab } from "@multica/core/local-conversation/protocol";
import type { runLocalProvider } from "./local-provider-runner";

const scope = { userId: "user", workspaceId: "workspace" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup(run: typeof runLocalProvider = async () => ({ output: "reply" }), provider: LocalProviderId = "claude", pool?: Pick<LocalCodexPool, "run" | "stop" | "steer">) {
  const root = await mkdtemp(join(tmpdir(), "side-access-"));
  const control = vi.fn(async () => ({}));
  const options = { root: join(root, "data"), apiUrl: "https://example.test", chooseDirectory: async () => root, choosePreview: async () => join(root, "selected"), notify: vi.fn(), run: vi.fn(run), sideControl: control, ...(pool ? { codexPool: () => pool } : {}) };
  const service = new LocalConversationService(options); service.setCurrentUser(scope.userId);
  const source = await service.request(scope, "create", { provider });
  await service.request(scope, "directory", { id: source.id });
  const side = await service.request(scope, "sideCreate", { id: source.id, requestId: "side" });
  cleanups.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  const sync = (tabs: SideWorkspaceTab[], revision = Date.now()) => service.request(scope, "sideWorkspaceSync", { conversationId: source.id, revision, panelOpen: true, visible: true, selectedTabId: tabs[0]?.id ?? null, tabs });
  return { root, service, source, side, sync, options, control };
}
describe("Side access and execution", () => {
  it("validates source ownership before accepting a snapshot", async () => {
    const { service, source } = await setup();
    await expect(service.request({ ...scope, workspaceId: "foreign" }, "sideWorkspaceSync", { conversationId: source.id, revision: 1, panelOpen: false, visible: false, selectedTabId: null, tabs: [] })).rejects.toThrow("unavailable");
  });
  it("keeps syncing the parent when an open Side conversation is archived", async () => {
    const { service, source, side, sync } = await setup();
    await service.request(scope, "update", { id: side.id, archived: true });
    await sync([{ id: "side:one", kind: "side", sessionId: side.id }], 1);
    expect(await service.request(scope, "sideWorkspaceState", { conversationId: source.id })).toMatchObject({ revision: 1 });
    await sync([], 2);
    expect(await service.request(scope, "sideWorkspaceState", { conversationId: source.id })).toMatchObject({ revision: 2, tabs: [] });
  });
  it("persists turn completion without waiting for a stalled Side renderer release", async () => {
    const { service, source, control } = await setup();
    let finish!: () => void;
    const cleanup = new Promise<void>((resolve) => { finish = resolve; });
    control.mockImplementation(async () => { await cleanup; return {}; });
    try {
      await service.request(scope, "send", { id: source.id, content: "Complete this turn" });
      await vi.waitFor(async () => {
        const completed = await service.request(scope, "read", { id: source.id });
        expect(completed.turns[0]).toMatchObject({ status: "completed", completedAt: expect.any(String) });
        expect(completed.messages.at(-1)?.content).toBe("reply");
      });
      expect(control).toHaveBeenCalledWith(expect.objectContaining({ op: "release" }), expect.any(AbortSignal));
    } finally { finish(); }
  });
  it("injects fresh ambient state into the provider input only, releasing on failure", async () => {
    const { service, source, sync, options, control } = await setup(async () => { throw new Error("fixture failure"); });
    await sync([{ id: "web:one", kind: "web", url: "https://example.test", title: "test page" }]);
    await service.request(scope, "send", { id: source.id, content: "What is here?" });
    await vi.waitFor(() => expect(control).toHaveBeenCalledWith(expect.objectContaining({ op: "release", conversationId: source.id }), expect.any(AbortSignal)));
    expect(await service.request(scope, "sideWorkspaceState", { conversationId: source.id })).toMatchObject({ conversationId: source.id, tabs: [{ id: "web:one" }] });
    expect(options.run.mock.calls[0]![0].content).toContain("<side-context");
    const stored = await service.request(scope, "read", { id: source.id });
    expect(stored.messages[0]?.content).toBe("What is here?"); expect(JSON.stringify(stored)).not.toContain("ambient-ui-state");
  });
  it("sends once when idle, persists source labels, and refuses a closed Side tab", async () => {
    const { service, source, side, sync, options } = await setup();
    await sync([{ id: "side:one", kind: "side", sessionId: side.id }], 1);
    const first = await service.steerSide(scope, source.id, side.id, "question", "one");
    expect(first.mode).toBe("new_run"); expect(first.turn_id).toBeTruthy();
    expect(await service.steerSide(scope, source.id, side.id, "question", "one")).toEqual(first);
    await expect(service.steerSide(scope, source.id, side.id, "changed", "one")).rejects.toThrow("request_id");
    await vi.waitFor(() => expect(options.run).toHaveBeenCalledOnce());
    const target = await service.request(scope, "read", { id: side.id });
    expect(target.messages[0]?.origin).toEqual({ conversationId: source.id, requestId: "one" });
    await sync([], 2);
    await expect(service.steerSide(scope, source.id, side.id, "another", "two")).rejects.toThrow("not_in_current_side");
  });
  it("durably queues for a busy provider and automatically starts after completion", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let calls = 0;
    const { service, source, side, sync } = await setup(async () => { if (++calls === 1) await gate; return { output: "done" }; });
    try {
      await sync([{ id: "side:one", kind: "side", sessionId: side.id }]);
      await service.request(scope, "send", { id: side.id, content: "busy" });
      const sent = await service.steerSide(scope, source.id, side.id, "next", "queue-one");
      expect(sent).toMatchObject({ mode: "queued", turn_id: null });
      expect((await service.request(scope, "read", { id: side.id })).promptQueue?.items).toHaveLength(1);
      finish();
      await vi.waitFor(async () => expect((await service.request(scope, "read", { id: side.id })).turns).toHaveLength(2));
      const target = await service.request(scope, "read", { id: side.id });
      expect(target.messages.find((message) => message.content === "next")?.origin?.conversationId).toBe(source.id);
    } finally { finish(); }
  });
  it.each([false, true])("acknowledges native steering or preserves an unknown receipt across restart (unknown=%s)", async (unknown) => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const pool = {
      run: vi.fn<LocalCodexPool["run"]>(async (_scope, input) => { input.onSessionId?.("native-thread"); await gate; return { output: "reply", sessionId: "native-thread" }; }),
      stop: vi.fn(async () => { finish(); }),
      steer: vi.fn(async () => { if (unknown) throw new Error("transport closed"); }),
    };
    const { service, source, side, sync, options } = await setup(undefined, "codex", pool);
    await sync([{ id: "side:one", kind: "side", sessionId: side.id }], 1);
    await service.request(scope, "send", { id: side.id, content: "busy" });
    await vi.waitFor(() => expect(pool.run).toHaveBeenCalledOnce());
    try {
      if (!unknown) {
        const sent = await service.steerSide(scope, source.id, side.id, "guidance", "one");
        expect(sent).toMatchObject({ mode: "steer", turn_id: expect.any(String) });
        expect((await service.request(scope, "read", { id: side.id })).messages.at(-1)).toMatchObject({ content: "guidance", steered: true, origin: { conversationId: source.id } });
        expect(await service.steerSide(scope, source.id, side.id, "guidance", "one")).toEqual(sent);
      } else {
        await expect(service.steerSide(scope, source.id, side.id, "guidance", "one")).rejects.toThrow("unknown");
        finish(); await service.stop();
        const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId); cleanups.push(() => reopened.stop());
        await reopened.request(scope, "sideWorkspaceSync", { conversationId: source.id, revision: 2, panelOpen: true, visible: true, selectedTabId: "side:one", tabs: [{ id: "side:one", kind: "side", sessionId: side.id }] });
        await expect(reopened.steerSide(scope, source.id, side.id, "guidance", "one")).rejects.toThrow("unknown after a restart");
      }
      expect(pool.steer).toHaveBeenCalledOnce();
    } finally { finish(); }
  });
  it("contains reads to the tab itself or directory descendants, including symlinks", async () => {
    const { root, service, source, sync } = await setup();
    const folder = join(root, "selected"); await mkdir(folder); const child = join(folder, "one.txt"), sibling = join(root, "secret.txt");
    await writeFile(child, "0123456789"); await writeFile(sibling, "PRIVATE"); await symlink(sibling, join(folder, "escape.txt"));
    // A file inside the conversation cwd uses the existing reader's cwd grant.
    const cwd = (await service.request(scope, "read", { id: source.id })).cwd;
    const approvedPath = join(cwd, `.side-test-${source.id}.txt`); await writeFile(approvedPath, "0123456789");
    cleanups.push(async () => { await rm(approvedPath, { force: true }); });
    await sync([{ id: "file:one", kind: "file", root: cwd, path: approvedPath, fileKind: "file" }], 1);
    expect(await service.readSideFile(scope, source.id, "file:one", undefined, 3, 4)).toMatchObject({ text: "3456", next_offset: 7 });
    await expect(service.readSideFile(scope, source.id, "file:one", sibling)).rejects.toThrow("not_in_current_side");
    await sync([{ id: "file:dir", kind: "file", root: folder, path: folder, fileKind: "directory" }], 2);
    await service.request(scope, "previewChoose", { kind: "directory" });
    expect(await service.readSideFile(scope, source.id, "file:dir", "one.txt")).toMatchObject({ text: "0123456789" });
    await expect(service.readSideFile(scope, source.id, "file:dir", "escape.txt")).rejects.toThrow("not_in_current_side");
    expect(await readFile(sibling, "utf8")).toBe("PRIVATE");
  });
});
