// @vitest-environment node
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ packaged: false, path: "/test-owned/worktree-a/apps/desktop" }));
vi.mock("electron", () => ({ app: { get isPackaged() { return state.packaged; }, getAppPath: () => state.path } }));
import { bundledCliPath, bundledCliSource } from "./bundled-cli";

const name = process.platform === "win32" ? "multica.exe" : "multica";

describe("CLI source matches the running Electron instance", () => {
  it("selects each dev worktree's own build output", () => {
    state.packaged = false;
    state.path = "/test-owned/worktree-a/apps/desktop";
    expect(bundledCliSource()).toEqual({ kind: "development", appPath: state.path, cliPath: join(state.path, "resources", "bin", name) });
    state.path = "/test-owned/worktree-b/apps/desktop";
    expect(bundledCliPath()).toBe(join(state.path, "resources", "bin", name));
  });
  it("selects unpacked resources inside the current packaged application", () => {
    state.packaged = true;
    state.path = "/test-owned/Multica.app/Contents/Resources/app.asar";
    expect(bundledCliSource()).toEqual({ kind: "packaged", appPath: state.path, cliPath: join(`${state.path}.unpacked`, "resources", "bin", name) });
  });
});
