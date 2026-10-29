import { SideWorkspaceControl } from "./side-workspace-control";
import { sideWorkspaceSyncSchema } from "@multica/core/local-conversation/protocol";
import { LocalTimingLog } from "./local-timing-log";
import { WebDiagnosticLog, snapshotDaemonLog } from "./developer-runtime-logs";
import { DeveloperLogExporter } from "./developer-log-export";
import { localProviderEnv } from "./local-provider-env";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, protocol, screen } from "electron";
import { randomBytes } from "node:crypto";
import { LOCAL_FILE_SCHEME, localFileScheme } from "./local-file-protocol";
import { homedir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import fixPath from "fix-path";
import { createElectronBusyInstallPrompt, setupAutoUpdater, updateInstallsOnQuit } from "./updater";
import {
  prepareDaemonForUpdateInstall,
  resumeDaemonAfterAbortedUpdateInstall,
  setupDaemonManager,
  daemonDiagnosticLogPath,
} from "./daemon-manager";
import { setupLocalDirectory } from "./local-directory";
import { setupTerminalCli } from "./terminal-cli-ipc";
import { registerDesktopProtocol, setupBrowserLogin } from "./browser-login-ipc";
import { LocalHostProxy } from "./local-conversation-proxy";
import { LocalV2Error, LocalV2Proxy } from "./local-conversation-v2";
import { localV2HostHandler } from "./local-v2-host";
import { isLocalV2FilePath, localV2ClientMessageSchema } from "@multica/core/local-conversation/v2";
import { ResourceWebPreview } from "./resource-web-preview";
import { createMacosChromeCookieImportAdapter } from "@tutti-os/browser-node/chrome-cookie-import/macos";
import { createDesktopSettingsHost } from "./desktop-settings-host";
import { multicaWorkspaceRequest } from "../local-host/multica-api-request";
import { SettingsOperationError } from "../shared/settings-operation-error";
import type { LocalConversationMethod, LocalConversationScope } from "@multica/core/local-conversation/protocol";
import { parseLocalTiming } from "@multica/tutti-agent-gui-host/local-timing";
import { developerLogQuerySchema } from "../shared/developer-logs";
import { configureLinuxFileDialogs } from "./linux-file-dialog";
import { openExternalSafely, downloadURLSafely } from "./external-url";
import { installContextMenu } from "./context-menu";
import { setupLocalFileContextMenu } from "./local-file-context-menu";
import { handleAppShortcut } from "./keyboard-shortcuts";
import { installNavigationGestures } from "./navigation-gestures";
import { installNavigationGuard } from "./navigation-guard";
import { installHtmlPreviewNavigationGuard } from "./html-preview-navigation";
import { createRendererWebPreferences } from "./renderer-web-preferences";
import { getAppVersion } from "./app-version";
import { DEVELOPER_LOGS_MCP_NAME, writeDeveloperLogsManifest } from "./developer-logs-mcp-server";
import { registerCodexStdioMcp } from "./codex-mcp-registration";
import { findLocalProvider } from "../local-host/local-provider-runner";
import { profileLogPath, readDesktopProfileCredentials } from "./daemon-profile";
import { desktopRuntimeRegistry, desktopRuntimeProfile } from "./desktop-runtime-instance";
import { loadRuntimeConfig } from "./runtime-config-loader";
import type { RuntimeConfigResult } from "../shared/runtime-config";
import {
  RENDERER_ROUTE_CONTEXT_CHANNEL,
  sanitizeRendererRouteContext,
  type RendererRouteContext,
} from "../shared/renderer-route-context";
import {
  createElectronReloadPrompt,
  installRendererRecoveryHandlers,
  type RendererRecoveryWindow,
} from "./renderer-recovery";
import { createBestEffortDevLog } from "./dev-log";
import { appendMissingPathDirs } from "./path-fallback";
import {
  writeFreezeBreadcrumb,
  readFreezeBreadcrumb,
  ackFreezeBreadcrumb,
  clearFreezeBreadcrumb,
} from "./freeze-breadcrumb";
import {
  loadWindowState,
  resolveWindowOptions,
  saveWindowStateToFile,
  snapshotWindowState,
  windowStateFilePath,
} from "./window-state";
import {
  encodeIssueWindowArgument,
  parseIssueWindowRequest,
  type IssueWindowContext,
} from "../shared/issue-window";
import {
  AUTH_SESSION_STATE_CHANNEL,
  parseAuthSessionUserId,
} from "../shared/auth-session";
import {
  MAIN_RENDERER_CHANNEL_STATE_CHANNEL,
  MainRendererMessageQueue,
  parseMainRendererChannelState,
  TAB_SELECTION_SHORTCUT_CHANNEL,
  type MainRendererMessageChannel,
} from "../shared/main-renderer-messages";
import { AuthSessionCoordinator } from "./auth-session-coordinator";
import {
  NotificationGate,
  parseNativeNotificationPayload,
} from "./notification-gate";

configureLinuxFileDialogs(app.commandLine);

// Guards against registering the will-download handler more than once on the
// same session. window.webContents.session is shared, and createWindow() can
// be called again on macOS (app "activate" after all windows are closed).
const downloadDialogSessions = new WeakSet<Electron.Session>();

function installDownloadSaveDialogHandler(window: BrowserWindow): void {
  const { session } = window.webContents;
  if (downloadDialogSessions.has(session)) return;
  downloadDialogSessions.add(session);
  session.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({
      defaultPath: join(app.getPath("downloads"), item.getFilename()),
    });
  });
}

// Bundled icon used for dock/taskbar branding. macOS/Windows production
// builds let the OS pick up the icon from the .app bundle / .exe resources,
// but Linux production needs an explicit BrowserWindow `icon` — AppImage
// direct-launch doesn't register the .desktop entry, so GNOME has no path
// from the running window to the hicolor icon and falls back to the
// theme default. Consumed in createWindow() (all platforms in dev, Linux
// in prod) and the macOS dev dock branch.
//
// `asarUnpack: resources/**` in electron-builder.yml extracts the icon to
// `app.asar.unpacked/`, but `__dirname` resolves into `app.asar/`. The
// Linux native window-icon code path expects a real filesystem path
// (unlike Electron's nativeImage loader which transparently reads from
// asar), so swap the segment — same pattern as bundledCliPath() in
// daemon-manager.ts. In dev `__dirname` has no `app.asar`, so the replace
// is a no-op.
const BUNDLED_ICON_PATH = join(__dirname, "../../resources/icon.png").replace(
  "app.asar",
  "app.asar.unpacked",
);

// macOS/Linux GUI launches inherit a minimal PATH from launchd that omits
// the user's shell config (~/.zshrc, Homebrew, nvm, ~/.local/bin, etc.).
// Run the user's login shell once to recover the real PATH so the bundled
// multica CLI can find agent binaries like claude/codex/opencode. Must run
// before any child_process.spawn / execFile call in the main process —
// ES module imports are hoisted, so this block executes before createWindow
// or any daemon-manager spawn.
if (process.platform !== "win32") {
  fixPath();
  // Fallback: ensure common install locations are on PATH when fix-path came
  // up short (broken shell rc, non-interactive $SHELL, missing entries).
  // Append only missing dirs — never prepend. Prepending /usr/local/bin over
  // a recovered login PATH shadows nvm/fnm Node with a stale system binary
  // (e.g. Node 12), which breaks shebang CLIs (`#!/usr/bin/env node`) such as
  // CodeBuddy and OpenClaw during daemon --version probes.
  process.env.PATH = appendMissingPathDirs(process.env.PATH ?? "", [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
  ]);
}

const PROTOCOL = "multica";
const devLog = is.dev ? createBestEffortDevLog() : undefined;

// Where the main process parks a freeze/crash breadcrumb until the next
// renderer boot flushes it to telemetry. Lives in userData so it survives a
// force-quit. Resolved lazily — app.getPath is only valid after `ready`.
function freezeBreadcrumbPath(): string {
  return join(app.getPath("userData"), "last-client-failure.json");
}

let mainWindow: BrowserWindow | null = null;
let localConversations: LocalHostProxy | null = null;
let localV2: LocalV2Proxy | null = null;
let localScopeTracker: ((scope: LocalConversationScope) => void) | undefined;
let localAvailability: import("../shared/local-host-availability").LocalHostAvailability | null = null;
let localTimingLog: LocalTimingLog | undefined;
let developerLogs: DeveloperLogExporter | undefined;
const issueWindows = new Set<BrowserWindow>();
const authSessionCoordinator = new AuthSessionCoordinator<BrowserWindow>(
  (window) => {
    issueWindows.delete(window);
    if (!window.isDestroyed()) window.close();
  },
);
const notificationGate = new NotificationGate();
const mainRendererMessages = new MainRendererMessageQueue();
let desktopInitialized = false;
let authSessionGeneration = 0;
let settingsUserId: string | null | undefined;
let publishDeveloperLogsManifest: (() => void) | undefined;
const webDiagnosticLogs = new Map<string, WebDiagnosticLog>();
function accountWebLog(userId: string): WebDiagnosticLog {
  let log = webDiagnosticLogs.get(userId);
  if (!log) {
    log = new WebDiagnosticLog(join(app.getPath("userData"), "local-conversations", "diagnostics"), runtimeConfigResult?.ok ? runtimeConfigResult.config.apiUrl : "", userId);
    webDiagnosticLogs.set(userId, log);
  }
  return log;
}
const rendererRouteContexts = new WeakMap<
  Electron.WebContents,
  RendererRouteContext
>();

let runtimeConfigResult: RuntimeConfigResult = {
  ok: false,
  error: { message: "Runtime config has not loaded yet" },
};

// --- Deep link helpers ---------------------------------------------------

function sendMainRendererMessage(
  channel: MainRendererMessageChannel,
  payload: unknown,
): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  window.webContents.send(channel, payload);
}

function focusMainWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function ensureMainWindow(): BrowserWindow | null {
  if (!desktopInitialized || !app.isReady()) return null;
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
  return mainWindow;
}

function dispatchToMainRenderer(
  channel: MainRendererMessageChannel,
  payload: unknown,
): void {
  mainRendererMessages.enqueue(channel, payload, sendMainRendererMessage);
  const window = ensureMainWindow();
  if (window) focusMainWindow(window);
}

function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${PROTOCOL}:`) return;

    // multica://auth/callback?token=<jwt>
    if (parsed.hostname === "auth" && parsed.pathname === "/callback") {
      const token = parsed.searchParams.get("token");
      if (token) dispatchToMainRenderer("auth:token", token);
      return;
    }

    // multica://invite/<invitationId>
    // Dispatched from the web invite page when the user chooses "Open in
    // desktop app". The renderer opens the invite overlay — no tab, no
    // route persistence, so deep-linking the same invite twice stays safe.
    if (parsed.hostname === "invite") {
      const id = parsed.pathname.replace(/^\//, "");
      if (id) dispatchToMainRenderer("invite:open", decodeURIComponent(id));
      return;
    }
  } catch {
    // Ignore malformed URLs
  }
}

// --- Window creation -----------------------------------------------------

// Tracks the OS-preferred language as last seen by the running process.
// Updated on each window-focus check so we can emit a `locale:system-changed`
// event to the renderer when the user changes their OS language without
// quitting the app — without restart, app.getPreferredSystemLanguages()
// would still report the boot value forever.
let lastKnownSystemLocale = "en";

function getSystemLocale(): string {
  return app.getPreferredSystemLanguages()[0] ?? "en";
}

function loadRenderer(window: BrowserWindow): void {
  const rendererEntry = join(__dirname, "../renderer/index.html");
  const rendererURL =
    is.dev && process.env["ELECTRON_RENDERER_URL"]
      ? process.env["ELECTRON_RENDERER_URL"]
      : pathToFileURL(rendererEntry).toString();

  // Installed before the load so the very first navigation is already covered.
  // Both the main window and every issue window load through here, so guarding
  // this one site covers both — see navigation-guard.ts for what is and is not
  // in scope (it is origin hardening; in-app routing never reaches it).
  installNavigationGuard(window, rendererURL);
  installHtmlPreviewNavigationGuard(window.webContents);

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    void window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window.loadFile(rendererEntry);
  }
}

function installLocaleRefresh(window: BrowserWindow): void {
  // Electron has no dedicated OS-language event. Check whenever any Multica
  // window regains focus, then broadcast so all open windows remain aligned.
  window.on("focus", () => {
    const current = getSystemLocale();
    if (current === lastKnownSystemLocale) return;
    lastKnownSystemLocale = current;
    for (const target of BrowserWindow.getAllWindows()) {
      if (!target.isDestroyed()) {
        target.webContents.send("locale:system-changed", current);
      }
    }
  });
}

function installWindowShortcutHandler(window: BrowserWindow): void {
  window.webContents.on("before-input-event", (event, input) => {
    const result = handleAppShortcut(input, window.webContents);
    if (result === "close-tab") {
      event.preventDefault();
      window.webContents.send("tab:close-active");
    } else if (result === "open-settings") {
      event.preventDefault();
      // Settings is a tab, so it can only live in the tabbed main window.
      // Routing through the queue means the chord also works from a
      // dedicated issue window — and from one that outlived the main window,
      // which is recreated and only then handed the request.
      dispatchToMainRenderer("settings:open", null);
    } else if (typeof result === "object" && result.action === "select-tab") {
      event.preventDefault();
      // Product tabs only exist in the main window. Route there even when the
      // chord came from a dedicated issue window, matching Settings behavior.
      dispatchToMainRenderer(TAB_SELECTION_SHORTCUT_CHANNEL, result.key);
    } else if (result) {
      event.preventDefault();
    }
  });
}

function createWindow(): BrowserWindow {
  // Pass the OS-preferred language to the renderer via additionalArguments
  // instead of a sync IPC call. process.argv is available to the preload
  // script before the first network request, so the renderer's i18next
  // instance can initialize with the right locale on the very first paint.
  const systemLocale = getSystemLocale();
  lastKnownSystemLocale = systemLocale;

  mainRendererMessages.resetReady();

  // Restore prior size/position/maximized/fullscreen (#5244), constraining
  // bounds to the work area of the display the window will land on.
  const stateFile = windowStateFilePath(app.getPath("userData"));
  const savedWindowState = loadWindowState(stateFile);
  const windowOpts = resolveWindowOptions(
    savedWindowState,
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea,
  );

  mainWindow = new BrowserWindow({
    width: windowOpts.width,
    height: windowOpts.height,
    ...(windowOpts.x != null && windowOpts.y != null
      ? { x: windowOpts.x, y: windowOpts.y }
      : {}),
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    // Center the native controls in the main window's 40px tab toolbar.
    trafficLightPosition: { x: 16, y: 13 },
    show: false,
    autoHideMenuBar: true,
    // Windows/Linux pick up the window/taskbar icon from this option.
    // On macOS it's ignored (dock comes from app.dock.setIcon below).
    // Linux production needs this explicitly because AppImage direct-launch
    // does not install a .desktop entry, so the WM has no other path to
    // the bundled icon; without it Ubuntu falls back to the theme default.
    ...(is.dev || process.platform === "linux"
      ? { icon: BUNDLED_ICON_PATH }
      : {}),
    webPreferences: createRendererWebPreferences(
      join(__dirname, "../preload/index.js"),
      systemLocale,
    ),
  });
  const window = mainWindow;

  // Persist bounds on resize/move (debounced) and on close so the next
  // launch restores size/position and max/fullscreen flags. getNormalBounds
  // is used so maximized/fullscreen still saves the restore size.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const persistWindowState = () => {
    const snap = snapshotWindowState(window);
    if (snap) saveWindowStateToFile(stateFile, snap);
  };
  const schedulePersistWindowState = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistWindowState, 400);
  };
  window.on("resize", schedulePersistWindowState);
  window.on("move", schedulePersistWindowState);
  window.on("close", () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistWindowState();
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      mainRendererMessages.resetReady();
    }
  });

  // Strip Origin header from WebSocket upgrade requests so the server's
  // origin whitelist doesn't reject connections from localhost dev origins.
  window.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["wss://*/*", "ws://*/*"] },
    (details, callback) => {
      delete details.requestHeaders["Origin"];
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  window.on("ready-to-show", () => {
    // Restore max/fullscreen after normal bounds are applied.
    if (windowOpts.isFullScreen) {
      window.setFullScreen(true);
    } else if (windowOpts.isMaximized) {
      window.maximize();
    }
    window.show();
  });

  installLocaleRefresh(window);

  installDownloadSaveDialogHandler(window);

  window.webContents.setWindowOpenHandler((details) => {
    openExternalSafely(details.url);
    return { action: "deny" };
  });

  // Calling preventDefault in the shared shortcut handler prevents both the
  // renderer keydown and the application-menu accelerator from double-firing.
  installWindowShortcutHandler(window);

  // Keep sanitized renderer diagnostics for local exports in every build.
  // Development builds also forward the original console to the launcher.
  window.webContents.on("console-message", (details) => {
    localTimingLog?.console(details.message);
    if (settingsUserId) accountWebLog(settingsUserId).console(details);
  });
  if (devLog) {
    // Forward every renderer-side console.* call. The detail object also
    // carries source URL + line — included so a thrown stack trace from
    // window.onerror is traceable back to a file.
    window.webContents.on("console-message", (details) => {
      const { level, message, sourceId, lineNumber } = details;
      devLog(level, `${message} (${sourceId}:${lineNumber})`);
    });

    // Fires when loadURL / loadFile can't reach its target (dev server
    // not up yet, network blip, file missing). errorCode is a Chromium
    // net error number; -3 = ABORTED is normal during HMR and skipped.
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (errorCode === -3) return;
        devLog(
          "did-fail-load",
          `code=${errorCode} desc=${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`,
        );
      },
    );
  }

  installRendererRecoveryHandlers(window as unknown as RendererRecoveryWindow, {
    isDev: is.dev,
    showReloadPrompt: createElectronReloadPrompt((options) =>
      dialog.showMessageBox(window, options),
    ),
    getDiagnosticContext: () => {
      // No `windowUrl`: it is an absolute install path (`/Users/<name>/...`
      // when installed per-user) and the bucketed route below already says
      // which page the window was on, which is the part we can act on.
      const routeContext = rendererRouteContexts.get(window.webContents);
      return routeContext ? { desktopRoute: routeContext } : {};
    },
    // Only persist in production: a true hang/crash can't report itself, so we
    // write a breadcrumb and the next renderer boot flushes it to PostHog. Dev
    // is excluded to keep field telemetry clean.
    persistBreadcrumb: is.dev
      ? undefined
      : (payload) =>
          writeFreezeBreadcrumb(freezeBreadcrumbPath(), {
            ownerId: `main:${window.id}`,
            kind: payload.kind,
            context: payload.context,
            ts: Date.now(),
            version: getAppVersion(),
          }),
    clearBreadcrumb: is.dev
      ? undefined
      : () =>
          clearFreezeBreadcrumb(freezeBreadcrumbPath(), `main:${window.id}`),
    log: devLog,
  });

  installContextMenu(window.webContents);
  installNavigationGestures(window);

  loadRenderer(window);
  return window;
}

function createIssueWindow(context: IssueWindowContext): void {
  const systemLocale = getSystemLocale();
  lastKnownSystemLocale = systemLocale;

  const window = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: context.title,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 17 },
    show: false,
    autoHideMenuBar: true,
    ...(is.dev || process.platform === "linux"
      ? { icon: BUNDLED_ICON_PATH }
      : {}),
    webPreferences: createRendererWebPreferences(
      join(__dirname, "../preload/index.js"),
      systemLocale,
      [encodeIssueWindowArgument(context)],
    ),
  });

  issueWindows.add(window);
  authSessionCoordinator.registerIssueWindow(window);
  window.on("closed", () => {
    issueWindows.delete(window);
    authSessionCoordinator.unregisterIssueWindow(window);
  });

  window.on("ready-to-show", () => window.show());
  installLocaleRefresh(window);
  installDownloadSaveDialogHandler(window);

  window.webContents.setWindowOpenHandler((details) => {
    void openExternalSafely(details.url);
    return { action: "deny" };
  });
  installWindowShortcutHandler(window);

  const initialRouteContext = sanitizeRendererRouteContext({
    surface: "tab",
    path: context.path,
    workspaceSlug: context.workspaceSlug,
  });
  if (initialRouteContext) {
    rendererRouteContexts.set(window.webContents, initialRouteContext);
  }
  installRendererRecoveryHandlers(window as unknown as RendererRecoveryWindow, {
    isDev: is.dev,
    showReloadPrompt: createElectronReloadPrompt((options) =>
      dialog.showMessageBox(window, options),
    ),
    getDiagnosticContext: () => {
      // No `windowUrl`: it is an absolute install path (`/Users/<name>/...`
      // when installed per-user) and the bucketed route below already says
      // which page the window was on, which is the part we can act on.
      const routeContext = rendererRouteContexts.get(window.webContents);
      return routeContext ? { desktopRoute: routeContext } : {};
    },
    persistBreadcrumb: is.dev
      ? undefined
      : (payload) =>
          writeFreezeBreadcrumb(freezeBreadcrumbPath(), {
            ownerId: `issue:${window.id}`,
            kind: payload.kind,
            context: payload.context,
            ts: Date.now(),
            version: getAppVersion(),
          }),
    clearBreadcrumb: is.dev
      ? undefined
      : () =>
          clearFreezeBreadcrumb(freezeBreadcrumbPath(), `issue:${window.id}`),
    log: devLog,
  });

  installContextMenu(window.webContents);
  loadRenderer(window);
}

// --- Dev / production isolation -------------------------------------------
// Give dev mode a separate app name and userData path so it gets its own
// single-instance lock file and doesn't conflict with the packaged production
// app. Must run BEFORE requestSingleInstanceLock() because the lock location
// is derived from the userData path. (Same approach VS Code uses for
// Stable / Insiders coexistence.)

// DESKTOP_APP_SUFFIX lets parallel worktrees run dev Electron side-by-side
// without fighting for the shared single-instance lock. The suffix is
// appended to the app name + userData path, so each worktree gets its own
// lock file. Default (no env var) keeps behavior unchanged — the common
// single-worktree case still lands at "Multica Canary".
const DEV_APP_NAME = process.env.DESKTOP_APP_SUFFIX
  ? `Multica Canary ${process.env.DESKTOP_APP_SUFFIX}`
  : "Multica Canary";

// Local conversation file content streams through this scheme (see the
// preload's file transport); it must be privileged before the app is ready.
const LOCAL_FILE_KEY = randomBytes(32).toString("hex");
protocol.registerSchemesAsPrivileged([localFileScheme]);

if (is.dev) {
  app.setName(DEV_APP_NAME);
  app.setPath("userData", join(app.getPath("appData"), DEV_APP_NAME));
} else {
  // Pin the production app name in code. Electron's Linux WM_CLASS is set
  // from app.getName() when the first BrowserWindow is realized; the
  // packaged ASAR's package.json `productName` already steers app.getName()
  // to "Multica", but anchoring it here makes WM_CLASS ↔ StartupWMClass
  // (declared in electron-builder.yml) survive a regression in
  // productName / the build pipeline. Must run before requestSingleInstanceLock().
  app.setName("Multica");
}

// --- Protocol registration -----------------------------------------------

// Generic dev Electron bundles share a macOS identity and cannot cold-start
// our entry point through Launch Services. Dev browser auth uses loopback.
registerDesktopProtocol(is.dev);

// --- Single instance lock ------------------------------------------------

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // Register before `ready`: macOS can deliver a cold-start URL while runtime
  // config is still loading. handleDeepLink queues the payload until both the
  // main window and its matching React listener exist.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  // Windows/Linux: second instance passes deep link via argv
  app.on("second-instance", (_event, argv) => {
    const window = ensureMainWindow();
    if (window) focusMainWindow(window);

    // On Windows the deep link URL is the last argv entry
    const deepLinkUrl = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (deepLinkUrl) handleDeepLink(deepLinkUrl);
  });

  // Windows/Linux cold-start deep links are safe to parse now. Delivery is
  // queued because desktopInitialized remains false until runtime config and
  // IPC handlers are ready.
  const coldStartDeepLink = process.argv.find((arg) =>
    arg.startsWith(`${PROTOCOL}://`),
  );
  if (coldStartDeepLink) handleDeepLink(coldStartDeepLink);

  app.whenReady().then(async () => {
    const viteEnv = import.meta.env as ImportMetaEnv & {
      readonly VITE_API_URL?: string;
      readonly VITE_WS_URL?: string;
      readonly VITE_APP_URL?: string;
    };

    runtimeConfigResult = await loadRuntimeConfig({
      isDev: is.dev,
      // electron-vite exposes VITE_* on import.meta.env for the main process;
      // keep dev URL overrides on the same source the renderer used before
      // runtime config moved endpoint resolution into main/preload.
      env: {
        apiUrl: viteEnv.VITE_API_URL,
        wsUrl: viteEnv.VITE_WS_URL,
        appUrl: viteEnv.VITE_APP_URL,
      },
    });

    if (runtimeConfigResult.ok) {
      const localApiUrl = runtimeConfigResult.config.apiUrl;
      // A missing local component must not prevent login and Settings from opening.
      await desktopRuntimeRegistry().register(localApiUrl).catch((error: unknown) => {
        console.error("[runtime-instance] Could not register this Desktop runtime", error);
      });
      const settingsHost = createDesktopSettingsHost(() => mainWindow, () => settingsUserId, () => authSessionGeneration, async ({ method, path, body }, signal, scope) => {
        const credentials = await readDesktopProfileCredentials(desktopRuntimeProfile());
        if (credentials.userId !== scope.userId || !credentials.token) throw new SettingsOperationError("account_mismatch", "The desktop is signed in to another account");
        return multicaWorkspaceRequest({ apiUrl: localApiUrl, token: credentials.token, workspaceId: scope.workspaceId }, method, path, body, signal);
      });
      localTimingLog = new LocalTimingLog(join(app.getPath("userData"), "local-conversations", "diagnostics"));
      const recentScopes = new Map<string, LocalConversationScope>();
      const notifyRenderer = (scope: LocalConversationScope, sessionId: string) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("local-conversation:changed", { scope, sessionId });
      };
      const pick = async (properties: Electron.OpenDialogOptions["properties"], defaultPath?: string) => {
        if (!mainWindow || mainWindow.isDestroyed()) return { path: null };
        const result = await dialog.showOpenDialog(mainWindow, { ...(defaultPath ? { defaultPath } : {}), properties });
        return { path: result.canceled ? null : result.filePaths[0] ?? null };
      };
      localConversations = new LocalHostProxy({
        apiUrl: localApiUrl,
        profile: desktopRuntimeProfile(),
        endpoint: () => desktopRuntimeRegistry().endpoint(localApiUrl),
        legacyDataDir: join(app.getPath("userData"), "local-conversations"),
        providerEnv: () => localProviderEnv(),
        notify: notifyRenderer,
        // Every open view re-reads its scope; the renderer keys queries by scope.
        resync: () => { for (const scope of recentScopes.values()) notifyRenderer(scope, ""); },
        availability: (value) => {
          localAvailability = value;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("local-conversation:availability", value);
        },
        timing: (record) => { const parsed = parseLocalTiming(record); if (parsed) localTimingLog?.write(parsed); },
        hostRequest: async (kind, raw) => {
          const payload = (raw ?? {}) as Record<string, unknown>;
          const signal = AbortSignal.timeout(90_000);
          switch (kind) {
            case "side_workspace": return sideWorkspaceControl.handle(raw, signal);
            case "confirmed_operation": {
              const request = payload.request as Parameters<NonNullable<typeof settingsHost.confirmAndApply>>[0];
              if (request?.scope?.userId !== settingsUserId) throw new SettingsOperationError("settings_host_unavailable", "Open the main app with the same signed-in account to continue");
              return settingsHost.confirmAndApply!(request, (payload.apply ?? null) as Parameters<NonNullable<typeof settingsHost.confirmAndApply>>[1], signal);
            }
            case "settings_host": return settingsHost.host!(payload.request as Parameters<NonNullable<typeof settingsHost.host>>[0], signal);
            case "pick_directory": return pick(["openDirectory", "createDirectory"], typeof payload.current === "string" ? payload.current : undefined);
            case "pick_preview": return pick([payload.kind === "directory" ? "openDirectory" : "openFile"]);
            case "developer_logs_export": {
              const scope = payload.scope as LocalConversationScope;
              if (!developerLogs || scope?.userId !== settingsUserId) throw new SettingsOperationError("settings_host_unavailable", "Open the main app with the same signed-in account to continue");
              return developerLogs.export(scope, developerLogQuerySchema.parse(payload.query), signal);
            }
          }
          throw new SettingsOperationError("unsupported_host_request", `Desktop cannot handle ${kind}`);
        },
      });
      localV2 = new LocalV2Proxy({
        apiUrl: localApiUrl,
        endpoint: () => desktopRuntimeRegistry().endpoint(localApiUrl),
        message: (scope, message) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("local-v2:message", { scope, message }); },
        connection: (scope, connected) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("local-v2:connection", { scope, connected }); },
        hostRequest: localV2HostHandler({
          currentUser: () => settingsUserId,
          side: (request, signal) => sideWorkspaceControl.handle(request, signal),
          confirm: (request, apply, signal) => settingsHost.confirmAndApply!(request, apply, signal),
          settingsHost: (request, signal) => settingsHost.host!(request, signal),
          developerLogs: (scope, query, signal) => {
            if (!developerLogs) throw new SettingsOperationError("settings_host_unavailable", "Developer logs are unavailable");
            return developerLogs.export(scope, query, signal);
          },
        }),
      });
      const trackScope = (scope: LocalConversationScope) => {
        recentScopes.delete(`${scope.userId}:${scope.workspaceId}`);
        recentScopes.set(`${scope.userId}:${scope.workspaceId}`, scope);
        if (recentScopes.size > 16) recentScopes.delete(recentScopes.keys().next().value!);
      };
      localScopeTracker = trackScope;
      localConversations.setUser(settingsUserId ?? null);
      localConversations.start();
      developerLogs = new DeveloperLogExporter({
        log: localTimingLog,
        exportsRoot: join(app.getPath("userData"), "local-conversations", "diagnostics", "exports"),
        runtime: { appVersion: getAppVersion(), platform: process.platform, arch: process.arch, electronVersion: process.versions.electron, chromeVersion: process.versions.chrome, nodeVersion: process.versions.node, packaged: app.isPackaged },
        assertScope: (scope) => { if (scope.userId !== settingsUserId) throw new Error("This account is no longer active"); },
        conversations: async (scope) => (await localConversations!.request(scope, "list", {})).map((conversation) => conversation.id),
        runtimeLogs: async (scope, since, until) => {
          const [web, daemon] = await Promise.all([accountWebLog(scope.userId).snapshot(since, until), snapshotDaemonLog(daemonDiagnosticLogPath())]);
          return { web, daemon };
        },
        chooseSavePath: async (filename) => {
          if (!mainWindow || mainWindow.isDestroyed()) return null;
          const result = await dialog.showSaveDialog(mainWindow, { defaultPath: join(app.getPath("downloads"), filename), filters: [{ name: "JSON", extensions: ["json"] }] });
          return result.canceled ? null : result.filePath ?? null;
        },
      });
      // Agents outside desktop conversations (daemon tasks, terminal Codex) reach the
      // same logs through a stdio MCP that Codex launches with this app's runtime.
      const diagnosticsDir = join(app.getPath("userData"), "local-conversations", "diagnostics");
      const apiUrl = runtimeConfigResult.config.apiUrl;
      publishDeveloperLogsManifest = () => {
        void writeDeveloperLogsManifest(diagnosticsDir, {
          version: 1, apiUrl, userId: settingsUserId ?? null,
          daemonLogPath: daemonDiagnosticLogPath() ?? profileLogPath(desktopRuntimeProfile()),
          runtime: { appVersion: getAppVersion(), platform: process.platform, arch: process.arch, electronVersion: process.versions.electron, chromeVersion: process.versions.chrome, nodeVersion: process.versions.node, packaged: app.isPackaged },
        }).catch((error: unknown) => console.warn("[developer-logs-mcp] Could not publish the diagnostics manifest", error));
      };
      publishDeveloperLogsManifest();
      void findLocalProvider("codex").then((codex) => registerCodexStdioMcp(codex, {
        name: DEVELOPER_LOGS_MCP_NAME,
        command: process.execPath,
        args: [join(__dirname, "developer-logs-mcp.js"), "--diagnostics", diagnosticsDir],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      })).then((result) => console.log(`[developer-logs-mcp] Codex registration: ${result}`))
        .catch((error: unknown) => console.warn("[developer-logs-mcp] Could not register with Codex", error));
    }
    ipcMain.handle("developer-logs:export", (event, scope: LocalConversationScope) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame || !developerLogs) throw new Error("Developer logs require the active main window");
      return developerLogs.save(scope);
    });
    let resourcePreview: ResourceWebPreview | undefined;
    const getResourcePreview = () => {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Main window is unavailable");
      return resourcePreview ??= new ResourceWebPreview(mainWindow, { createSource: () => createMacosChromeCookieImportAdapter({ isEnabled: () => true }) });
    };
    const sideWorkspaceControl = new SideWorkspaceControl({
      currentUser: () => settingsUserId,
      snapshot: (scope, conversationId) => localConversations!.request(scope, "sideWorkspaceState", { conversationId }),
      assertTurn: async (scope, id, turnId) => { const entry = await localConversations!.request(scope, "read", { id }); if (!entry.turns.some((turn) => turn.id === turnId && turn.status === "running")) throw new Error("The controlling Side execution has ended"); },
      preview: getResourcePreview,
      send: (command) => { if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Main window is unavailable"); mainWindow.webContents.send("side-workspace:command", command); },
      activity: (tabId, conversationId, turnId, active) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("side-workspace:activity", { tabId, conversationId, turnId, active }); },
    });
    mainWindow?.once("closed", () => sideWorkspaceControl.dispose());
    ipcMain.handle("side-workspace:ack", (event, reply) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("Side acknowledgement requires the main window");
      sideWorkspaceControl.ack(reply);
    });
    const previewFor = (event: Electron.IpcMainInvokeEvent, scope: LocalConversationScope) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame || !localConversations) throw new Error("Preview requires the active main window");
      if (scope.userId !== settingsUserId) throw new Error("This account is no longer active");
      return { preview: getResourcePreview(), owner: JSON.stringify([scope.userId, scope.workspaceId]) };
    };
    ipcMain.handle("resource-preview:request", (event, scope: LocalConversationScope, command: import("../shared/resource-preview").WebPreviewCommand) => {
      const { preview, owner } = previewFor(event, scope);
      return preview.request(owner, command);
    });
    ipcMain.handle("resource-preview:chrome-profiles", (event, scope: LocalConversationScope) => previewFor(event, scope).preview.chromeProfiles.list());
    ipcMain.handle("resource-preview:import-chrome-profile", (event, scope: LocalConversationScope, input: import("../shared/resource-preview").ChromeProfileImportInput) => {
      const { preview, owner } = previewFor(event, scope);
      return preview.chromeProfiles.import(owner, input);
    });
    ipcMain.handle("resource-preview:cancel-chrome-import", (event, scope: LocalConversationScope, requestId: string) => {
      const { preview, owner } = previewFor(event, scope);
      return preview.chromeProfiles.cancel(owner, requestId);
    });
    setupLocalFileContextMenu({ getWindow: () => mainWindow, currentUser: () => settingsUserId, request: (scope, method, params) => localConversations!.request(scope, method, params) });
    ipcMain.handle("local-conversation:request", async (event, scope: LocalConversationScope, method: LocalConversationMethod, params) => {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || !localConversations) throw new Error("Local conversations require the active main window");
      localScopeTracker?.(scope);
      const result = await localConversations.request(scope, method, params);
      if (method === "sideWorkspaceSync" && (result as { revision: number }).revision === (params as { revision: number }).revision) sideWorkspaceControl.reconcile(sideWorkspaceSyncSchema.parse(params));
      return result;
    });
    const mainFrame = (event: Electron.IpcMainInvokeEvent, scope: LocalConversationScope) => {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || !localV2) throw new Error("Local conversations require the active main window");
      if (scope?.userId !== settingsUserId || !scope.workspaceId) throw new Error("This account is no longer active");
      return localV2;
    };
    ipcMain.handle("local-v2:request", (event, scope: LocalConversationScope, method: "GET" | "POST", path: string, body?: unknown) => {
      if (method !== "GET" && method !== "POST") throw new Error("Invalid local conversation request");
      return mainFrame(event, scope).request(scope, method, path, body).catch((error: unknown) => {
        // Structured kinds survive IPC only inside the message.
        if (error instanceof LocalV2Error) throw new Error(`${error.kind}: ${error.message}`);
        throw error;
      });
    });
    ipcMain.handle("local-v2:send", (event, scope: LocalConversationScope, message: unknown) => {
      const parsed = localV2ClientMessageSchema.parse(message);
      return mainFrame(event, scope).send(scope, parsed);
    });
    ipcMain.handle("local-conversation:availability", (event) => event.sender === mainWindow?.webContents ? localAvailability : null);
    ipcMain.on("local-conversation:file-key", (event) => {
      event.returnValue = event.sender === mainWindow?.webContents && event.senderFrame === event.sender.mainFrame ? LOCAL_FILE_KEY : "";
    });
    protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
      const url = new URL(request.url);
      const scope = { userId: url.searchParams.get("userId") ?? "", workspaceId: url.searchParams.get("workspaceId") ?? "" };
      if (!localConversations || url.searchParams.get("k") !== LOCAL_FILE_KEY || !scope.userId || scope.userId !== settingsUserId || !scope.workspaceId) return new Response("Forbidden", { status: 403 });
      const route = url.pathname.replace(/^\/+/, "");
      if (localV2 && route.startsWith("v2/")) {
        const target = url.searchParams.get("target") ?? "";
        if (request.method === "POST" && route === "v2/attachments") return localV2.file(request, scope, "/attachments");
        if (request.method === "GET" && isLocalV2FilePath(target)) return localV2.file(request, scope, target);
        return new Response("Not found", { status: 404 });
      }
      if (request.method === "POST" && route === "upload") return localConversations.file(request, scope, null);
      if (request.method === "GET" && route.startsWith("files/")) return localConversations.file(request, scope, decodeURIComponent(route.slice("files/".length)));
      return new Response("Not found", { status: 404 });
    });

    electronApp.setAppUserModelId(
      is.dev ? "ai.multica.desktop.dev" : "ai.multica.desktop",
    );

    // macOS: replace the default Electron dock icon with the bundled logo
    // so the Canary dev build is visually distinct from a stock Electron
    // run. `app.dock` is macOS-only — guard the call.
    if (is.dev && process.platform === "darwin" && app.dock) {
      const icon = nativeImage.createFromPath(BUNDLED_ICON_PATH);
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    }

    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    // IPC: open URL in default browser (used by renderer for Google login).
    // All scheme-allowlist enforcement lives in openExternalSafely — this
    // is the single audit point for renderer-controlled URLs reaching the
    // OS shell under the app's intentional webSecurity: false configuration
    // (the renderer itself runs sandboxed).
    ipcMain.handle("shell:openExternal", (_event, url: string) => {
      return openExternalSafely(url);
    });
    setupBrowserLogin({
      development: is.dev,
      getWindow: () => mainWindow,
      getAppUrl: () => {
        if (!runtimeConfigResult.ok) throw new Error("Desktop runtime config is unavailable");
        return runtimeConfigResult.config.appUrl;
      },
      onToken: (token) => dispatchToMainRenderer("auth:token", token),
    });

    // Renderer requests its own window close (e.g. Cmd+W on the last main
    // tab, or Cmd+W anywhere in a dedicated issue window).
    ipcMain.on("window:close", (event) => {
      BrowserWindow.fromWebContents(event.sender)?.close();
    });

    ipcMain.handle("window:open-issue", (event, request: unknown) => {
      if (!BrowserWindow.fromWebContents(event.sender)) {
        return { ok: false, reason: "invalid_request" } as const;
      }
      const context = parseIssueWindowRequest(request);
      if (!context) {
        return { ok: false, reason: "invalid_request" } as const;
      }
      createIssueWindow(context);
      return { ok: true } as const;
    });

    ipcMain.handle("file:download-url", (event, url: string) => {
      const sourceWindow = BrowserWindow.fromWebContents(event.sender);
      if (!sourceWindow) {
        console.warn("[download] ignored file:download-url — source window torn down");
        return;
      }
      downloadURLSafely(sourceWindow, url);
    });

    // Sync IPC: app version + normalized OS for preload. Sync (not invoke) so
    // preload can attach the values to `desktopAPI.appInfo` before any renderer
    // code reads them, ensuring the very first HTTP request from the renderer
    // already carries X-Client-Version and X-Client-OS.
    ipcMain.on("app:get-info", (event) => {
      const p = process.platform;
      const os = p === "darwin" ? "macos" : p === "win32" ? "windows" : p === "linux" ? "linux" : "unknown";
      event.returnValue = { version: getAppVersion(), os };
    });

    // Sync IPC: read + clear any freeze/crash breadcrumb left by a previous
    // session. The renderer flushes it to telemetry on boot (it couldn't be
    // reported when it happened — the renderer was hung or gone). Read-and-
    // clear so a failure reports exactly once.
    ipcMain.on("freeze:get-last", (event) => {
      event.returnValue = readFreezeBreadcrumb(freezeBreadcrumbPath());
    });

    // The renderer got its breadcrumb event to posthog — retire that exact
    // payload. A newer failure recorded since the read keeps its own ts and
    // survives to be reported on the next boot.
    ipcMain.on("freeze:ack", (event, ts: unknown) => {
      if (!BrowserWindow.fromWebContents(event.sender)) return;
      if (typeof ts !== "number" || !Number.isFinite(ts)) return;
      ackFreezeBreadcrumb(freezeBreadcrumbPath(), ts);
    });

    // Sync IPC: preload exposes the validated runtime config before renderer
    // boot. If desktop.json exists but is invalid, renderer receives the
    // blocking error and must not silently fall back to the cloud defaults.
    ipcMain.on("runtime-config:get", (event) => {
      event.returnValue = runtimeConfigResult;
    });

    ipcMain.on(RENDERER_ROUTE_CONTEXT_CHANNEL, (event, context: unknown) => {
      if (!BrowserWindow.fromWebContents(event.sender)) return;
      const sanitized = sanitizeRendererRouteContext(context);
      if (!sanitized) return;
      rendererRouteContexts.set(event.sender, sanitized);
    });

    // Preload announces each listener only after it has been installed by the
    // main renderer. Ignore issue-window senders so they can never drain a
    // payload intended for the tabbed application window.
    ipcMain.on(
      MAIN_RENDERER_CHANNEL_STATE_CHANNEL,
      (event, state: unknown) => {
        if (!mainWindow || event.sender !== mainWindow.webContents) return;
        const parsed = parseMainRendererChannelState(state);
        if (!parsed) return;
        mainRendererMessages.setReady(
          parsed.channel,
          parsed.ready,
          sendMainRendererMessage,
        );
      },
    );

    // Account identity is the only cross-renderer auth signal. Main remains
    // authoritative and closes issue windows instead of copying credentials.
    ipcMain.on(AUTH_SESSION_STATE_CHANNEL, (event, value: unknown) => {
      const sourceWindow = BrowserWindow.fromWebContents(event.sender);
      const userId = parseAuthSessionUserId(value);
      if (!sourceWindow || userId === undefined) return;

      if (sourceWindow === mainWindow) {
        settingsUserId = userId;
        localConversations?.setUser(userId);
        publishDeveloperLogsManifest?.();
        const accountInvalidated = authSessionCoordinator.reportMain(userId);
        if (accountInvalidated) {
          sideWorkspaceControl.dispose();
          resourcePreview?.dispose();
          authSessionGeneration += 1;
          mainRendererMessages.clear("inbox:open");
        }
        return;
      }
      if (issueWindows.has(sourceWindow)) {
        authSessionCoordinator.reportIssue(sourceWindow, userId);
      }
    });

    // IPC: toggle immersive mode — hides the macOS traffic lights so full-screen
    // modals (e.g. create-workspace) can place UI in the top-left corner
    // without fighting the native window controls' hit-test.
    ipcMain.handle("window:setImmersive", (event, immersive: boolean) => {
      if (process.platform !== "darwin") return;
      BrowserWindow.fromWebContents(event.sender)?.setWindowButtonVisibility(
        !immersive,
      );
    });

    // Main owns foreground detection and item-level dedupe. Every renderer
    // has its own WebSocket and `document.hasFocus()` only describes that one
    // window, so renderer-only gating can emit N duplicate system banners.
    ipcMain.on("notification:show", (event, value: unknown) => {
      const sourceWindow = BrowserWindow.fromWebContents(event.sender);
      if (!sourceWindow) return;
      if (sourceWindow === mainWindow) {
        if (!authSessionCoordinator.hasActiveMainSession()) return;
      } else if (
        !issueWindows.has(sourceWindow) ||
        !authSessionCoordinator.isCurrentIssueSession(sourceWindow)
      ) {
        return;
      }

      const payload = parseNativeNotificationPayload(value);
      if (!payload || !Notification.isSupported()) return;
      const anyWindowFocused = BrowserWindow.getAllWindows().some(
        (window) => !window.isDestroyed() && window.isFocused(),
      );
      if (!notificationGate.shouldShow(payload.itemId, anyWindowFocused)) {
        return;
      }

      const notification = new Notification({
        title: payload.title,
        body: payload.body,
      });
      const notificationSessionGeneration = authSessionGeneration;
      notification.on("click", () => {
        // A banner emitted for user A must not navigate after the main window
        // logs out or switches to user B.
        if (notificationSessionGeneration !== authSessionGeneration) return;
        // Recreate the main window when an issue-only window outlived it, then
        // wait for the inbox listener before delivering the navigation.
        dispatchToMainRenderer("inbox:open", {
          slug: payload.slug,
          itemId: payload.itemId,
          issueKey: payload.issueKey,
        });
      });
      notification.show();
    });

    // IPC: update the dock / taskbar unread badge. Values above 99 render as
    // "99+". macOS is the primary target (user-visible dock badge); Linux
    // Unity launchers also respect `setBadgeCount`. Windows' taskbar overlay
    // needs a pre-rendered PNG and is deferred — the OS notification + the
    // in-app inbox sidebar cover the core UX there for now.
    ipcMain.on("badge:set", (_event, rawCount: number) => {
      const count = Math.max(0, Math.floor(rawCount));
      if (process.platform === "darwin") {
        const label = count === 0 ? "" : count > 99 ? "99+" : String(count);
        app.dock?.setBadge(label);
      } else {
        app.setBadgeCount(count);
      }
    });

    desktopInitialized = true;
    createWindow();

    setupAutoUpdater(() => mainWindow, {
      // Windows only (the updater ignores it elsewhere): stop the bundled
      // daemon before the installer runs so multica.exe is replaced. #8823
      daemonGate: {
        prepare: prepareDaemonForUpdateInstall,
        resumeAfterAbortedInstall: resumeDaemonAfterAbortedUpdateInstall,
        confirmInstallWhileBusy: createElectronBusyInstallPrompt((options) =>
          mainWindow && !mainWindow.isDestroyed()
            ? dialog.showMessageBox(mainWindow, options)
            : dialog.showMessageBox(options),
        ),
      },
      // The sidecar runs this app's executable: stop it before the installer
      // replaces the app, after asking when that would interrupt a turn.
      beforeInstall: async () => {
        if (!localConversations) return true;
        const busy = await localConversations.drain().catch(() => 0);
        if (busy > 0 && mainWindow && !mainWindow.isDestroyed()) {
          const chinese = app.getLocale().startsWith("zh");
          const choice = await dialog.showMessageBox(mainWindow, {
            type: "warning", noLink: true, defaultId: 0, cancelId: 0,
            buttons: chinese ? ["等待完成", "立即更新"] : ["Wait", "Update now"],
            message: chinese ? "本地对话仍在运行" : "Local conversations are still running",
            detail: chinese ? "立即更新会中断正在运行的本地对话。" : "Updating now interrupts the local conversations that are running.",
          });
          if (choice.response !== 1) { await localConversations.undrain().catch(() => {}); return false; }
        }
        await localConversations.stopSidecar().catch(() => {});
        return true;
      },
    });
    setupDaemonManager(() => mainWindow, {
      quiesceLocalConversations: async () => {
        if (!localConversations) return true;
        const busy = await localConversations.drain().catch(() => 0);
        if (busy > 0) await localConversations.undrain().catch(() => {});
        return busy === 0;
      },
    });
    let localShutdown = false;
    app.on("before-quit", (event) => {
      if (event.defaultPrevented || localShutdown) return;
      event.preventDefault(); localShutdown = true;
      // Local conversations keep running in the daemon; only flush Desktop's own logs.
      // The sidecar runs this app's executable, so it cannot outlive the app when
      // quitting installs a downloaded update or the AppImage mount disappears.
      const proxy = localConversations;
      const stopped = proxy && (process.env.APPIMAGE || updateInstallsOnQuit()) ? proxy.stopSidecar().catch(() => {}) : Promise.resolve();
      void stopped.finally(() => proxy?.close());
      void Promise.all([stopped, localTimingLog?.flush(), ...[...webDiagnosticLogs.values()].map((log) => log.flush())]).finally(() => app.quit());
    });

    setupLocalDirectory(() => mainWindow);
    setupTerminalCli(() => mainWindow);

    app.on("activate", () => {
      const window = ensureMainWindow();
      if (window) focusMainWindow(window);
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
