// @vitest-environment node
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalConversationClient } from "@multica/core/local-conversation/protocol";
import { LocalResourceReader } from "../local-host/local-resource-reader";
import { setupLocalFileContextMenu } from "./local-file-context-menu";

type Item = { label?: string; role?: string; type?: string; click?: () => void };
const mock = vi.hoisted(() => ({
  handle: vi.fn(), popup: vi.fn(), items: [] as Item[],
  writeText: vi.fn().mockResolvedValue(undefined), reveal: vi.fn(), locale: ["en-US"],
}));
vi.mock("electron", () => ({
  ipcMain: { handle: mock.handle },
  clipboard: { writeText: mock.writeText }, shell: { showItemInFolder: mock.reveal },
  app: { getPreferredSystemLanguages: () => mock.locale },
  BrowserWindow: { fromWebContents: () => undefined },
  Menu: class {
    items: Item[] = [];
    append(item: Item) { this.items.push(item); mock.items.push(item); }
    popup = mock.popup;
  },
  MenuItem: class { constructor(input: Item) { Object.assign(this, input); } },
}));

let base: string;
let cwd: string;
let user: string | null;
let destroyed: boolean;
const webContents = { mainFrame: {} };
const event = { sender: webContents, senderFrame: webContents.mainFrame };
const scope = { userId: "user", workspaceId: "workspace" };
const request = vi.fn<LocalConversationClient["request"]>();
type Handler = (event: unknown, scope: unknown, input: unknown) => Promise<void>;
const show = (url: string, hasSelection = false, sourceEvent: unknown = event) =>
  (mock.handle.mock.calls[0]![1] as Handler)(sourceEvent, scope, { sessionId: "source-session", url, hasSelection });
const click = (label: string) => {
  const item = mock.items.find((entry) => entry.label === label);
  expect(item).toBeDefined(); item!.click!();
};
const revealLabel = process.platform === "darwin" ? "Open in Finder" : "Show in Folder";

beforeEach(async () => {
  vi.clearAllMocks(); mock.items.length = 0; mock.locale = ["en-US"]; user = "user"; destroyed = false;
  base = await realpath(await mkdtemp(join(tmpdir(), "multica-file-menu-")));
  cwd = join(base, "project"); await mkdir(cwd);
  const reader = new LocalResourceReader(join(base, "preferences"));
  request.mockImplementation(async (_scope, method, params) => {
    if (method === "read") return { cwd } as never;
    if (method === "previewLocate") return await reader.locate((params as { path: string }).path, cwd) as never;
    throw new Error(`Unexpected request: ${method}`);
  });
  setupLocalFileContextMenu({
    getWindow: () => ({ webContents, isDestroyed: () => destroyed }) as never,
    currentUser: () => user, request,
  });
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); vi.restoreAllMocks(); });

it("copies and reveals the canonical target without reading a large binary installer", async () => {
  const path = join(cwd, "测试 build 100%.dmg");
  await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1));
  await show(pathToFileURL(path).href);
  expect(mock.items.map((item) => item.label)).toEqual(["Copy Path", revealLabel]);
  click("Copy Path"); await vi.waitFor(() => expect(mock.writeText).toHaveBeenCalledExactlyOnceWith(path));
  click(revealLabel); await vi.waitFor(() => expect(mock.reveal).toHaveBeenCalledExactlyOnceWith(path));
  expect(request.mock.calls.every(([, method]) => method === "read" || method === "previewLocate")).toBe(true);
  expect(request).toHaveBeenCalledWith(scope, "previewLocate", { id: "source-session", path });
});

it.each(["./archive.zip", "archive.zip", "./checksum.sha256:12:4"])("resolves %s against the source cwd and retains normal Copy", async (url) => {
  const path = join(cwd, url.replace(/^\.\//, "").replace(/:\d+:\d+$/, ""));
  await writeFile(path, "file");
  await show(url, true);
  expect(mock.items[0]).toMatchObject({ role: "copy" });
  click("Copy Path"); await vi.waitFor(() => expect(mock.writeText).toHaveBeenCalledWith(path));
});

it("accepts absolute paths with source line suffixes", async () => {
  const path = join(cwd, "校验 文件.sha256"); await writeFile(path, "hash");
  await show(`${encodeURI(path)}#L20`);
  click("Copy Path"); await vi.waitFor(() => expect(mock.writeText).toHaveBeenCalledWith(path));
});

it.each(["https://example.com/file.zip", "file://other-host/tmp/file.zip", "javascript:alert(1)"])("rejects non-local target %s", async (url) => {
  await expect(show(url)).rejects.toThrow("local file path");
  expect(mock.popup).not.toHaveBeenCalled();
});

it("reports missing files and rejects links escaping the source root", async () => {
  await expect(show("./missing.zip")).rejects.toThrow("ENOENT");
  const outside = join(base, "outside.zip"); await writeFile(outside, "outside");
  await expect(show(outside)).rejects.toThrow("Choose this folder");
  await symlink(outside, join(cwd, "escape.zip"));
  await expect(show("./escape.zip")).rejects.toThrow("Choose this folder");
  expect(mock.popup).not.toHaveBeenCalled();
});

it("rejects stale accounts and subframe IPC before accessing files", async () => {
  user = "another-user";
  await expect(show("./file.zip")).rejects.toThrow("account");
  user = "user";
  await expect(show("./file.zip", false, { ...event, senderFrame: {} })).rejects.toThrow("main window");
  expect(request).not.toHaveBeenCalled();
});

it("does not execute menu actions after the account changes", async () => {
  const path = join(cwd, "archive.zip"); await writeFile(path, "file");
  await show(path); user = null;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  click("Copy Path"); click(revealLabel);
  await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(2));
  expect(mock.writeText).not.toHaveBeenCalled(); expect(mock.reveal).not.toHaveBeenCalled();
});

it.each([
  ["zh-CN", "复制路径", process.platform === "darwin" ? "在 Finder 中显示" : "在文件夹中显示"],
  ["zh-TW", "複製路徑", process.platform === "darwin" ? "在 Finder 中顯示" : "在資料夾中顯示"],
  ["ja-JP", "パスをコピー", process.platform === "darwin" ? "Finder で表示" : "フォルダーに表示"],
  ["ko-KR", "경로 복사", process.platform === "darwin" ? "Finder에서 보기" : "폴더에서 보기"],
])("localizes the native menu for %s", async (locale, copy, reveal) => {
  mock.locale = [locale]; const path = join(cwd, "file.zip"); await writeFile(path, "file");
  await show(path); expect(mock.items.map((item) => item.label)).toEqual([copy, reveal]);
});
