// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
const fake = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), show: vi.fn(async () => ({ response: 0 })), copy: vi.fn() }));
vi.mock("electron", () => ({ clipboard: { writeText: fake.copy }, dialog: { showMessageBox: fake.show }, ipcMain: { handle: (name: string, callback: (...args: unknown[]) => unknown) => fake.handlers.set(name, callback) } }));
import { createDesktopSettingsHost } from "./desktop-settings-host";

beforeEach(() => { fake.handlers.clear(); fake.show.mockClear(); fake.copy.mockClear(); fake.show.mockResolvedValue({ response: 0 }); });
function fixture() {
  let user = "user", generation = 1;
  const mainFrame = {};
  const webContents = { mainFrame, send: vi.fn((_channel, request) => queueMicrotask(() => fake.handlers.get("settings-host:reply")!({ sender: webContents, senderFrame: mainFrame }, { id: request.id, ok: true, result: { status: "ready" } }))) };
  const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
  const host = createDesktopSettingsHost(() => window, () => user, () => generation);
  return { host, window, webContents, changeUser: () => { user = "other"; generation++; } };
}
describe("native Settings confirmation", () => {
  it("defaults to cancel and requires an actual native confirmation result", async () => {
    const f = fixture();
    const request = { operation: "settings_remove_member", scope: { userId: "user", workspaceId: "workspace" }, input: { id: "member" } };
    expect(await f.host.confirm!(request, new AbortController().signal)).toBe(false);
    expect(fake.show).toHaveBeenCalledWith(f.window, expect.objectContaining({ defaultId: 0, cancelId: 0, buttons: ["Cancel", "Apply"] }));
    fake.show.mockResolvedValueOnce({ response: 1 });
    expect(await f.host.confirm!(request, new AbortController().signal)).toBe(true);
  });
  it("refuses to display token values after the account changes", async () => {
    const f = fixture(); f.changeUser();
    await expect(f.host.showSecret!("Key", "PRIVATE", { userId: "user", workspaceId: "workspace" }, new AbortController().signal)).rejects.toThrow("same signed-in account");
    expect(fake.show).not.toHaveBeenCalled();
  });
  it("copies a new token only when the human selects Copy token", async () => {
    const f = fixture(); fake.show.mockResolvedValueOnce({ response: 1 });
    await f.host.showSecret!("Key", "PRIVATE", { userId: "user", workspaceId: "workspace" }, new AbortController().signal);
    expect(fake.copy).not.toHaveBeenCalled();
    fake.show.mockResolvedValueOnce({ response: 0 });
    await f.host.showSecret!("Key", "PRIVATE", { userId: "user", workspaceId: "workspace" }, new AbortController().signal);
    expect(fake.copy).toHaveBeenCalledWith("PRIVATE");
  });
  it("rejects replies from another renderer and aborts pending host requests", async () => {
    const f = fixture(); f.webContents.send.mockImplementation(() => {});
    const controller = new AbortController();
    const result = f.host.host!({ operation: "settings_read_device", scope: { userId: "user", workspaceId: "workspace" }, input: {} }, controller.signal);
    const id = f.webContents.send.mock.calls[0]![1].id;
    expect(() => fake.handlers.get("settings-host:reply")!({ sender: {}, senderFrame: {} }, { id, ok: true })).toThrow("requesting main window");
    controller.abort(); await expect(result).rejects.toThrow("execution has ended");
  });
});
