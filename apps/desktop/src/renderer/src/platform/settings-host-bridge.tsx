import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "@multica/ui/components/common/theme-provider";
import { useAuthStore } from "@multica/core/auth";
import { getCurrentWsId, getCurrentSlug } from "@multica/core/platform";
import { api } from "@multica/core/api";
import { paths } from "@multica/core/paths";
import { SETTINGS_OPERATIONS } from "@multica/core/settings/operations";
import { useFeatureEnabled } from "@multica/core/config";
import { PROJECT_WORKFLOWS_V1_FLAG } from "@multica/core/feature-flags";
import { z } from "zod";
import { useChatStore } from "@multica/core/chat";
import { useCommentComposerStore } from "@multica/core/issues/stores";
import { useIssueOpeningStore } from "@multica/core/issues/stores/issue-opening-store";
import { QUICK_CREATE_FIELDS, MANUAL_CREATE_FIELDS, useIssueCreateSettingsStore } from "@multica/core/issues/stores/issue-create-settings-store";
import { useShortcutStore, SHORTCUT_ACTIONS, SHORTCUT_ACTION_BY_ID, isShortcutAllowedForAction, shortcutChordEquals, type ShortcutActionId, type ShortcutChord } from "@multica/core/shortcuts";
import { useTabStore } from "@/stores/tab-store";
import type { SettingsHostMessage } from "../../../shared/settings-host";

type DeviceAPI = Pick<Window, "daemonAPI" | "updater">;
export interface SettingsRendererDependencies {
  device: DeviceAPI;
  theme(): string;
  setTheme(value: "light" | "dark" | "system"): void;
  refresh(): Promise<void>;
  open(domain: string): void;
  appInfo?: { version: string; os: string };
}

export function assertSettingsScope(request: SettingsHostMessage) {
  const auth = useAuthStore.getState();
  if (auth.status !== "authenticated" || auth.user?.id !== request.scope.userId || getCurrentWsId() !== request.scope.workspaceId) throw new Error("Select the originating account and workspace before using these settings");
}

export async function performSettingsHostOperation(request: SettingsHostMessage, deps: SettingsRendererDependencies, signal?: AbortSignal): Promise<unknown> {
  const check = () => { signal?.throwIfAborted(); assertSettingsScope(request); };
  check();
  if (request.operation === "settings_assert_scope") return { status: "ready" };
  if (request.operation === "settings_refresh") { await deps.refresh(); return { status: "refreshed" }; }
  const definition = SETTINGS_OPERATIONS.find((entry) => entry.name === request.operation && !entry.request);
  if (!definition) throw new Error("Unknown device setting operation");
  const input = z.object(definition.schema).strict().parse(request.input);
  if (request.operation === "settings_open") { deps.open(String(input.domain)); return { status: "opened", domain: input.domain }; }
  if (request.operation === "settings_read_device") {
    const [daemon, daemonPreferences, updates] = await Promise.all([deps.device.daemonAPI.getStatus(), deps.device.daemonAPI.getPrefs(), deps.device.updater.getPreferences()]);
    const runtimes = input.probe_runtimes ? await deps.device.daemonAPI.probeRuntimes() : undefined;
    check();
    const composer = useCommentComposerStore.getState();
    const create = useIssueCreateSettingsStore.getState();
    const overrides = useShortcutStore.getState().overrides;
    return { app: deps.appInfo, theme: deps.theme(), sticky_composer: composer.sticky, running_agent_reply: composer.runningAgentReply, issue_open_mode: useIssueOpeningStore.getState().openMode, floating_chat: useChatStore.getState().floatingChatEnabled, quick_create_fields: create.quickCreateFields, manual_create_fields: create.manualCreateFields, daemon: { state: daemon.state, externally_managed: daemon.externallyManaged, uptime: daemon.uptime, device_name: daemon.deviceName, workspace_count: daemon.workspaceCount }, daemon_preferences: daemonPreferences, update_preferences: updates, ...(runtimes ? { runtimes } : {}), shortcuts: SHORTCUT_ACTIONS.map((action) => ({ id: action.id, default: action.defaultShortcut, current: overrides[action.id] === undefined ? action.defaultShortcut : overrides[action.id] })) };
  }
  if (request.operation === "settings_update_device") {
    const fields = input.fields as Record<string, unknown>;
    if ((fields.daemon_auto_start !== undefined || fields.daemon_auto_stop !== undefined) && (await deps.device.daemonAPI.getStatus()).externallyManaged) throw new Error("This daemon is externally managed; change its preferences in that environment");
    check();
    // Async device writes precede local store updates so a rejected device operation is visible.
    if (typeof fields.automatic_updates === "boolean") await deps.device.updater.setAutomaticUpdates(fields.automatic_updates);
    check();
    if (fields.daemon_auto_start !== undefined || fields.daemon_auto_stop !== undefined) await deps.device.daemonAPI.setPrefs({ ...(typeof fields.daemon_auto_start === "boolean" ? { autoStart: fields.daemon_auto_start } : {}), ...(typeof fields.daemon_auto_stop === "boolean" ? { autoStop: fields.daemon_auto_stop } : {}) });
    check();
    if (fields.theme) deps.setTheme(fields.theme as "light" | "dark" | "system");
    const composer = useCommentComposerStore.getState();
    if (typeof fields.sticky_composer === "boolean" && composer.sticky !== fields.sticky_composer) composer.toggleSticky();
    if (fields.running_agent_reply) composer.setRunningAgentReply(fields.running_agent_reply as "steer" | "after_run");
    if (fields.issue_open_mode) useIssueOpeningStore.getState().setOpenMode(fields.issue_open_mode as "page" | "peek");
    if (typeof fields.floating_chat === "boolean") useChatStore.getState().setFloatingChatEnabled(fields.floating_chat);
    const create = useIssueCreateSettingsStore.getState();
    if (Array.isArray(fields.quick_create_fields)) QUICK_CREATE_FIELDS.forEach((key) => create.setQuickCreateFieldVisible(key, (fields.quick_create_fields as unknown[]).includes(key)));
    if (Array.isArray(fields.manual_create_fields)) MANUAL_CREATE_FIELDS.forEach((key) => create.setManualCreateFieldVisible(key, (fields.manual_create_fields as unknown[]).includes(key)));
    return { status: "applied", fields: Object.keys(fields) };
  }
  if (request.operation === "settings_set_shortcut") {
    const actionId = String(input.action_id) as ShortcutActionId;
    const action = SHORTCUT_ACTION_BY_ID[actionId];
    if (!action) throw new Error("Unknown shortcut action");
    const shortcut = input.reset ? action.defaultShortcut : input.shortcut as ShortcutChord | null | undefined;
    if (shortcut === undefined) throw new Error("Supply a shortcut, null to disable it, or reset=true");
    if (shortcut && !isShortcutAllowedForAction(actionId, shortcut)) throw new Error("This shortcut is reserved or unsupported for this action");
    const state = useShortcutStore.getState();
    if (shortcut && SHORTCUT_ACTIONS.some((other) => {
      const override = state.overrides[other.id];
      return other.id !== actionId && shortcutChordEquals(shortcut, override === undefined ? other.defaultShortcut ?? null : override);
    })) throw new Error("This shortcut conflicts with another action");
    if (input.reset) state.resetShortcut(actionId); else state.setShortcut(actionId, shortcut);
    return { status: "applied", action_id: actionId };
  }
  if (request.operation === "settings_device_action") {
    const action = String(input.action);
    if (action === "check_update") return deps.device.updater.checkForUpdates();
    if (action === "download_update") { await deps.device.updater.downloadUpdate(); return { status: "downloaded" }; }
    if (action === "install_update") { await deps.device.updater.installUpdate(); return { status: "installation_requested" }; }
    if (action === "open_daemon_log") { const result = await deps.device.daemonAPI.openLogFile(); if (!result.success) throw new Error(result.error ?? "The daemon log is unavailable"); return { status: "opened" }; }
    if ((await deps.device.daemonAPI.getStatus()).externallyManaged) throw new Error("This daemon is externally managed; use its own environment for lifecycle changes");
    check();
    const method = { daemon_start: "start", daemon_stop: "stop", daemon_restart: "restart" }[action] as "start" | "stop" | "restart" | undefined;
    if (!method) throw new Error("Unknown device action");
    const result = await deps.device.daemonAPI[method]();
    if (!result.success) throw new Error(result.error ?? "Daemon action failed");
    return { status: "applied", action };
  }
  throw new Error("Unsupported device operation");
}

export function DesktopSettingsHostBridge() {
  const { theme, setTheme } = useTheme();
  const workflowsEnabled = useFeatureEnabled(PROJECT_WORKFLOWS_V1_FLAG, false);
  const client = useQueryClient();
  const deps = useRef<SettingsRendererDependencies>(null!);
  deps.current = {
    device: window, appInfo: window.desktopAPI.appInfo, theme: () => theme ?? "system", setTheme,
    refresh: async () => {
      const user = await api.getMe();
      if (user.id === useAuthStore.getState().user?.id) useAuthStore.getState().setUser(user);
      await client.invalidateQueries();
    },
    open: (domain) => {
      const slug = getCurrentSlug();
      if (!slug) throw new Error("No active workspace");
      const tab = domain === "statuses" ? workflowsEnabled ? "workflows" : "issue-statuses" : domain;
      useTabStore.getState().openTab(`${paths.workspace(slug).settings()}?tab=${encodeURIComponent(tab)}`, "", { activate: true });
    },
  };
  useEffect(() => {
    const active = new Map<string, AbortController>();
    const unsubscribe = window.desktopAPI.settingsHost?.subscribe((request) => {
      if (request.operation === "settings_cancel") { active.get(request.id)?.abort(); return; }
      const controller = new AbortController(); active.set(request.id, controller);
      void performSettingsHostOperation(request, deps.current, controller.signal).then((result) => window.desktopAPI.settingsHost?.respond({ id: request.id, ok: true, result }), (error) => window.desktopAPI.settingsHost?.respond({ id: request.id, ok: false, error: error instanceof Error ? error.message : "Could not apply settings" })).catch(() => {}).finally(() => active.delete(request.id));
    });
    return () => { unsubscribe?.(); active.forEach((controller) => controller.abort()); };
  }, []);
  return null;
}
