// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ packaged: false, exists: false, version: "0.7.0", valid: true, exec: vi.fn(), managed: vi.fn() }));
vi.mock("electron", () => ({ app: { get isPackaged() { return mocks.packaged; }, getAppPath: () => "/test-owned/dev/apps/desktop" }, ipcMain: {}, BrowserWindow: class {}, shell: {} }));
vi.mock("fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: (path: string) => mocks.exists && path === "/test-owned/dev/apps/desktop/resources/bin/multica" }));
vi.mock("child_process", () => ({ execFile: mocks.exec }));
vi.mock("./cli-bootstrap", () => ({ ensureManagedCli: mocks.managed, managedCliPath: () => "/test-owned/managed/multica" }));
vi.mock("./bundled-cli", () => ({ bundledCliPath: () => "/test-owned/dev/apps/desktop/resources/bin/multica" }));

beforeEach(() => {
  vi.resetModules();
  mocks.packaged = false; mocks.exists = false; mocks.version = "0.7.0"; mocks.valid = true;
  mocks.exec.mockReset().mockImplementation((_path, _args, _options, callback) => callback(mocks.valid ? null : new Error("invalid executable"), JSON.stringify({ version: mocks.version })));
  mocks.managed.mockReset().mockRejectedValue(new Error("Test-owned unavailable release"));
});

describe("daemon CLI binding in development", () => {
  it("refuses to download or use a PATH CLI when the worktree build is missing", async () => {
    const { resolveCliBinary } = await import("./daemon-manager");
    expect(await resolveCliBinary()).toBeNull();
    expect(mocks.managed).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
    mocks.exists = true;
    expect(await resolveCliBinary()).toBe("/test-owned/dev/apps/desktop/resources/bin/multica");
  });
  it("refuses fallback when the worktree binary fails validation", async () => {
    mocks.exists = true; mocks.valid = false;
    const { resolveCliBinary } = await import("./daemon-manager");
    expect(await resolveCliBinary()).toBeNull();
    expect(mocks.managed).not.toHaveBeenCalled();
    expect(mocks.exec.mock.calls.every(([path]) => path === "/test-owned/dev/apps/desktop/resources/bin/multica")).toBe(true);
  });
  it("refreshes the expected version after a dev rebuild", async () => {
    mocks.exists = true;
    const { resolveCliBinary, getCliBinaryVersion } = await import("./daemon-manager");
    await resolveCliBinary();
    expect(await getCliBinaryVersion()).toBe("0.7.0");
    mocks.version = "0.8.0";
    expect(await getCliBinaryVersion()).toBe("0.8.0");
  });
  it("never substitutes another CLI for a missing packaged component", async () => {
    mocks.packaged = true;
    mocks.managed.mockResolvedValue("/test-owned/managed/multica");
    const { resolveCliBinary } = await import("./daemon-manager");
    expect(await resolveCliBinary()).toBeNull();
    expect(mocks.managed).not.toHaveBeenCalled();
  });
});
