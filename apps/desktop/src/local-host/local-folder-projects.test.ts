// @vitest-environment node
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalConversationService } from "./local-conversation-service";

const scope = { userId: "user", workspaceId: "workspace" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "multica-folder-projects-"));
  const directory = join(root, "local-repository"); await mkdir(directory);
  const options = { root, apiUrl: "https://example.test", notify: vi.fn(),
    chooseDirectory: vi.fn<(current: string) => Promise<string | null>>(async () => directory),
    find: vi.fn(async () => "/test-owned/fake-provider"),
    run: vi.fn(async () => ({ output: "Reply", sessionId: "test-native-session" })),
  };
  const service = new LocalConversationService(options); service.setCurrentUser(scope.userId);
  cleanups.push(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  return { directory, options, service };
}

describe("local folder projects", () => {
  it("adds and deduplicates a selected directory, persists it after restart, and does not start a model or conversation", async () => {
    const { directory, service, options } = await setup();
    await writeFile(join(directory, "untouched.txt"), "Original content");
    const project = await service.request(scope, "folderProjectAdd", {});
    expect(project).toMatchObject({ title: "local-repository", path: await realpath(directory) });
    expect(await service.request(scope, "folderProjectAdd", {})).toEqual(project);
    expect(await service.request(scope, "folderProjects", {})).toEqual([project]);
    expect(await service.request(scope, "list", {})).toEqual([]);
    expect(options.find).not.toHaveBeenCalled(); expect(options.run).not.toHaveBeenCalled();
    expect(await readFile(join(directory, "untouched.txt"), "utf8")).toBe("Original content");
    await service.stop();
    const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId);
    try { expect(await reopened.request(scope, "folderProjects", {})).toEqual([project]); }
    finally { await reopened.stop(); }
  });
  it.each(["codex", "claude"] as const)("starts new %s conversations in the registered folder, independently of cloud project associations", async (provider) => {
    const { directory, service, options } = await setup();
    const project = await service.request(scope, "folderProjectAdd", {});
    const entry = await service.request(scope, "create", { provider, folderProjectId: project!.id });
    expect(entry.cwd).toBe(await realpath(directory)); expect(entry.projectId).toBeNull();
    await service.request(scope, "send", { id: entry.id, content: "Use this working directory" });
    await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[0]?.status).toBe("completed"));
    expect(options.run).toHaveBeenCalledWith(expect.objectContaining({ provider, cwd: await realpath(directory) }), expect.any(Function), expect.any(AbortSignal));
  });
  it("treats picker cancellation as a no-op and rejects files or missing folders", async () => {
    const { directory, service, options } = await setup();
    options.chooseDirectory.mockResolvedValueOnce(null);
    expect(await service.request(scope, "folderProjectAdd", {})).toBeNull();
    expect(await service.request(scope, "folderProjects", {})).toEqual([]);
    const file = join(directory, "file.txt"); await writeFile(file, "file");
    options.chooseDirectory.mockResolvedValueOnce(file);
    await expect(service.request(scope, "folderProjectAdd", {})).rejects.toThrow("folder is unavailable");
    const project = await service.request(scope, "folderProjectAdd", {});
    await rm(directory, { recursive: true });
    await expect(service.request(scope, "create", { provider: "codex", folderProjectId: project!.id })).rejects.toThrow("folder is unavailable");
    expect(await service.request(scope, "list", {})).toEqual([]);
    expect(options.run).not.toHaveBeenCalled();
  });
  it("isolates folder catalogs by account and workspace and rejects foreign folder IDs", async () => {
    const { service } = await setup();
    const project = await service.request(scope, "folderProjectAdd", {});
    const otherWorkspace = { ...scope, workspaceId: "other-workspace" };
    expect(await service.request(otherWorkspace, "folderProjects", {})).toEqual([]);
    await expect(service.request(otherWorkspace, "create", { provider: "codex", folderProjectId: project!.id })).rejects.toThrow("not found");
    service.setCurrentUser("other-user");
    expect(await service.request({ ...scope, userId: "other-user" }, "folderProjects", {})).toEqual([]);
    await expect(service.request(scope, "folderProjects", {})).rejects.toThrow("no longer active");
  });
  it("discards a pending folder selection after the active account changes", async () => {
    const { directory, service, options } = await setup();
    let select!: (path: string) => void;
    options.chooseDirectory.mockImplementationOnce(() => new Promise((resolve) => { select = resolve; }));
    const pending = service.request(scope, "folderProjectAdd", {});
    await vi.waitFor(() => expect(select).toBeTypeOf("function"));
    service.setCurrentUser("other-user"); select(directory);
    await expect(pending).rejects.toThrow("no longer active");
    service.setCurrentUser(scope.userId);
    expect(await service.request(scope, "folderProjects", {})).toEqual([]);
  });
});
