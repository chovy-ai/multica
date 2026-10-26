import { beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ user: { id: "user" }, status: "authenticated" }));
vi.mock("@multica/core/auth", () => ({ useAuthStore: Object.assign((selector: (state: typeof auth) => unknown) => selector(auth), { getState: () => auth }) }));
const chat = vi.hoisted(() => ({ floatingChatEnabled: true, setFloatingChatEnabled: vi.fn() }));
vi.mock("@multica/core/chat", async (original) => ({ ...await original<object>(), useChatStore: Object.assign((selector: (state: typeof chat) => unknown) => selector(chat), { getState: () => chat }) }));
import { setCurrentWorkspace } from "@multica/core/platform";
import { useCommentComposerStore } from "@multica/core/issues/stores";
import { useIssueOpeningStore } from "@multica/core/issues/stores/issue-opening-store";
import { useIssueCreateSettingsStore } from "@multica/core/issues/stores/issue-create-settings-store";
import { useShortcutStore } from "@multica/core/shortcuts";
import { performSettingsHostOperation, type SettingsRendererDependencies } from "./settings-host-bridge";
import type { SettingsHostMessage } from "../../../shared/settings-host";

const scope = { userId: "user", workspaceId: "workspace" };
function fixture() {
  const start = vi.fn(async () => ({ success: true })), setPrefs = vi.fn(async () => ({ autoStart: true, autoStop: false }));
  const setTheme = vi.fn(), open = vi.fn();
  const deps: SettingsRendererDependencies = { device: { daemonAPI: { start, stop: start, restart: start, getStatus: async () => ({ state: "stopped" }), getPrefs: async () => ({ autoStart: true, autoStop: false }), setPrefs }, updater: { getPreferences: async () => ({ automaticUpdates: true }), setAutomaticUpdates: async (automaticUpdates: boolean) => ({ automaticUpdates }), checkForUpdates: async () => ({ ok: true, currentVersion: "1", latestVersion: "1", available: false }), downloadUpdate: async () => [], installUpdate: async () => {} } } as unknown as SettingsRendererDependencies["device"], theme: () => "system", setTheme, refresh: async () => {}, open };
  const call = (operation: string, input: Record<string, unknown> = {}, override = scope) => performSettingsHostOperation({ id: "test", operation, input, scope: override } satisfies SettingsHostMessage, deps);
  return { deps, call, start, setPrefs, setTheme, open };
}
beforeEach(() => {
  auth.user = { id: "user" };
  auth.status = "authenticated";
  setCurrentWorkspace("workspace", "workspace");
  useCommentComposerStore.setState({ sticky: false, runningAgentReply: "after_run" });
  useIssueOpeningStore.setState({ openMode: "page" });
  useShortcutStore.setState({ overrides: {} });
});

describe("Settings host renderer boundary", () => {
  it("writes through existing Settings stores and preserves unspecified device preferences", async () => {
    const f = fixture();
    expect(await f.call("settings_update_device", { fields: { theme: "dark", sticky_composer: true, issue_open_mode: "peek", quick_create_fields: ["due_date"], daemon_auto_stop: true } })).toMatchObject({ status: "applied" });
    expect(f.setTheme).toHaveBeenCalledWith("dark");
    expect(useCommentComposerStore.getState()).toMatchObject({ sticky: true, runningAgentReply: "after_run" });
    expect(useIssueOpeningStore.getState().openMode).toBe("peek");
    expect(useIssueCreateSettingsStore.getState().quickCreateFields).toEqual(["due_date"]);
    expect(f.setPrefs).toHaveBeenCalledWith({ autoStop: true });
  });

  it("refuses another account or workspace before any local action", async () => {
    const f = fixture();
    await expect(f.call("settings_device_action", { action: "daemon_start" }, { ...scope, userId: "other" })).rejects.toThrow("originating account");
    await expect(f.call("settings_update_device", { fields: { theme: "light" } }, { ...scope, workspaceId: "other" })).rejects.toThrow("originating account");
    expect(f.start).not.toHaveBeenCalled(); expect(f.setTheme).not.toHaveBeenCalled();
    auth.status = "recovering";
    await expect(f.call("settings_device_action", { action: "daemon_start" })).rejects.toThrow("originating account");
    expect(f.start).not.toHaveBeenCalled();
  });

  it("distinguishes opening a settings tab from an applied change", async () => {
    const f = fixture();
    expect(await f.call("settings_open", { domain: "mcp" })).toEqual({ status: "opened", domain: "mcp" });
    expect(f.open).toHaveBeenCalledWith("mcp");
    await expect(f.call("settings_open", { domain: "unknown" })).rejects.toThrow();
    await expect(f.call("execute_shell", { command: "echo unsafe" })).rejects.toThrow("Unknown device");
  });

  it("does not claim a failed daemon restart succeeded", async () => {
    const f = fixture(); f.start.mockResolvedValueOnce({ success: false, error: "busy" } as { success: boolean });
    await expect(f.call("settings_device_action", { action: "daemon_restart" })).rejects.toThrow("busy");
  });
  it("does not claim lifecycle changes applied to an externally managed daemon", async () => {
    const f = fixture();
    f.deps.device.daemonAPI.getStatus = async () => ({ state: "running", externallyManaged: true });
    await expect(f.call("settings_device_action", { action: "daemon_restart" })).rejects.toThrow("externally managed");
    await expect(f.call("settings_update_device", { fields: { daemon_auto_start: true } })).rejects.toThrow("externally managed");
    expect(f.start).not.toHaveBeenCalled(); expect(f.setPrefs).not.toHaveBeenCalled();
  });
  it("does not continue a device write after cancellation during preflight", async () => {
    const f = fixture(); const controller = new AbortController();
    let release!: (value: { state: "stopped" }) => void;
    f.deps.device.daemonAPI.getStatus = () => new Promise((resolve) => { release = resolve; });
    const result = performSettingsHostOperation({ id: "cancelled", operation: "settings_update_device", scope, input: { fields: { daemon_auto_start: true } } }, f.deps, controller.signal);
    controller.abort(); release({ state: "stopped" });
    await expect(result).rejects.toThrow();
    expect(f.setPrefs).not.toHaveBeenCalled();
  });

  it("rejects invalid keyboard actions and supports explicitly disabling a shortcut", async () => {
    const f = fixture();
    await expect(f.call("settings_set_shortcut", { action_id: "not-an-action", shortcut: null })).rejects.toThrow("Unknown shortcut");
    await f.call("settings_set_shortcut", { action_id: "openSearch", shortcut: null });
    expect(useShortcutStore.getState().overrides.openSearch).toBeNull();
    await f.call("settings_set_shortcut", { action_id: "openSearch", reset: true });
    expect(useShortcutStore.getState().overrides.openSearch).toBeUndefined();
  });

  it("returns safe device state without persisting or exposing function objects", async () => {
    const f = fixture();
    const result = await f.call("settings_read_device");
    expect(result).toMatchObject({ theme: "system", daemon: { state: "stopped" }, update_preferences: { automaticUpdates: true } });
    expect(JSON.stringify(result)).not.toContain("setPrefs");
  });
});
