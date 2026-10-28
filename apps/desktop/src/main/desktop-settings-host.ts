import { randomUUID } from "node:crypto";
import { clipboard, dialog, ipcMain, type BrowserWindow } from "electron";
import { SETTINGS_OPERATIONS } from "@multica/core/settings/operations";
import type { SettingsHostMessage, SettingsHostReply } from "../shared/settings-host";
import { confirmThenApply, type SettingsHostRequest, type SettingsToolOptions } from "../local-host/local-settings-tools";
import type { SettingsRequest, SettingsScope } from "@multica/core/settings/operations";
import { publicSettingsValue, SettingsOperationError } from "../shared/settings-operation-error";

/**
 * Desktop owns human confirmation: a confirmed write is performed here with
 * `apply`, never by the conversation host that asked for it.
 */
export function createDesktopSettingsHost(getWindow: () => BrowserWindow | null, getUser: () => string | null | undefined, getGeneration: () => number, apply: (request: SettingsRequest, signal: AbortSignal, scope: SettingsScope) => Promise<unknown>): Pick<SettingsToolOptions, "host" | "confirmAndApply"> {
  const pending = new Map<string, { window: BrowserWindow; generation: number; resolve(value: unknown): void; reject(error: Error): void }>();
  ipcMain.handle("settings-host:reply", (event, reply: SettingsHostReply) => {
    if (!reply || typeof reply.id !== "string") throw new Error("Invalid settings reply");
    const entry = pending.get(reply.id);
    if (!entry) return;
    if (event.sender !== entry.window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("Settings reply requires the requesting main window");
    if (entry.generation !== getGeneration()) entry.reject(new Error("The account changed during this request"));
    else if (reply.ok) entry.resolve(reply.result);
    else entry.reject(new Error(typeof reply.error === "string" ? reply.error.slice(0, 1000) : "Could not apply device settings"));
  });
  const windowFor = (request: SettingsHostRequest) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || getUser() !== request.scope.userId) throw new SettingsOperationError("settings_host_unavailable", "Open the main app with the same signed-in account to use device settings");
    return window;
  };
  const host = async (request: SettingsHostRequest, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    const window = windowFor(request), id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (action: () => void) => { clearTimeout(timer); signal.removeEventListener("abort", abort); pending.delete(id); action(); };
      const cancel = () => { try { window.webContents.send("settings-host:request", { ...request, id, operation: "settings_cancel", input: {} }); } catch { /* A closed renderer has no remaining local writes. */ } };
      const abort = () => { cancel(); finish(() => reject(new SettingsOperationError("execution_ended", "This execution has ended"))); };
      const timer = setTimeout(() => { cancel(); finish(() => reject(new SettingsOperationError("settings_host_timeout", "The settings UI did not respond; no successful change is confirmed"))); }, 90_000);
      pending.set(id, { window, generation: getGeneration(), resolve: (value) => finish(() => resolve(value)), reject: (error) => finish(() => reject(error)) });
      signal.addEventListener("abort", abort, { once: true });
      const message: SettingsHostMessage = { ...request, id };
      try { window.webContents.send("settings-host:request", message); } catch (error) { finish(() => reject(error)); }
      if (signal.aborted) abort();
    });
  };
  return {
    host,
    confirmAndApply: confirmThenApply({ request: apply, confirm: async (request, signal) => {
      const window = windowFor(request), generation = getGeneration();
      // Validate the selected account/workspace in the renderer before showing a native approval.
      await host({ ...request, operation: "settings_assert_scope", input: {} }, signal);
      signal.throwIfAborted();
      const description = SETTINGS_OPERATIONS.find((entry) => entry.name === request.operation)?.description ?? "Apply this settings operation?";
      const details = JSON.stringify({ workspace_id: request.scope.workspaceId, target: request.input.id ?? request.input.project_id ?? request.input.email, impact: publicSettingsValue(request.impact), changes: request.input }, null, 2);
      const detail = details.length > 12000 ? `${details.slice(0, 12000)}\n\nAdditional details were truncated. Cancel to inspect the full requested change first.` : details;
      const response = await dialog.showMessageBox(window, { type: "question", title: "Multica Settings", message: description, detail, buttons: ["Cancel", "Apply"], defaultId: 0, cancelId: 0, noLink: true, signal });
      signal.throwIfAborted();
      if (generation !== getGeneration()) throw new SettingsOperationError("account_changed", "The account changed before confirmation");
      if (response.response !== 1) return false;
      await host({ ...request, operation: "settings_assert_scope", input: {} }, signal);
      return true;
    }, showSecret: async (name, secret, scope, signal) => {
      signal.throwIfAborted();
      await host({ operation: "settings_assert_scope", scope, input: {} }, signal);
      const window = windowFor({ operation: "settings_create_token", scope, input: {} });
      const result = await dialog.showMessageBox(window, { type: "info", title: "Multica API Token", message: name, detail: `Save this token now. It is shown only here and will not be included in the agent response.\n\n${secret}`, buttons: ["Copy token", "Done"], defaultId: 1, cancelId: 1, noLink: true, signal });
      signal.throwIfAborted();
      windowFor({ operation: "settings_create_token", scope, input: {} });
      if (result.response === 0) clipboard.writeText(secret);
    } }),
  };
}
