export const IPC_CHANNELS = {
  appRequestPersistFlush: "app:request-persist-flush",
  appPersistFlushComplete: "app:persist-flush-complete",
  appRequestWindowClose: "app:request-window-close",
  appWindowCloseDecision: "app:window-close-decision",
  clipboardReadText: "clipboard:read-text",
  clipboardWriteText: "clipboard:write-text",
  filesystemCreateDirectory: "filesystem:create-directory",
  filesystemReadFileBytes: "filesystem:read-file-bytes",
  filesystemReadFileText: "filesystem:read-file-text",
  filesystemWriteFileText: "filesystem:write-file-text",
  filesystemCopyEntry: "filesystem:copy-entry",
  filesystemMoveEntry: "filesystem:move-entry",
  filesystemRenameEntry: "filesystem:rename-entry",
  filesystemDeleteEntry: "filesystem:delete-entry",
  filesystemReadDirectory: "filesystem:read-directory",
  filesystemStat: "filesystem:stat",
  workspaceSelectDirectory: "workspace:select-directory",
  workspaceSelectFiles: "workspace:select-files",
  workspaceSelectContextEntries: "workspace:select-context-entries",
  workspaceEnsureDirectory: "workspace:ensure-directory",
  workspaceReadFile: "workspace:read-file",
  workspaceWriteFile: "workspace:write-file",
  workspaceWriteFileText: "workspace:write-file-text",
  workspaceCopyPath: "workspace:copy-path",
  workspaceFileTransferSelectUploadSources:
    "workspace-file-transfer:select-upload-sources",
  workspaceFileTransferRegisterUploadSources:
    "workspace-file-transfer:register-upload-sources",
  workspaceFileTransferInspectUploadSources:
    "workspace-file-transfer:inspect-upload-sources",
  workspaceFileTransferSelectDownloadSavePath:
    "workspace-file-transfer:select-download-save-path",
  workspaceFileTransferRevealLocalPath:
    "workspace-file-transfer:reveal-local-path",
  persistenceReadWorkspaceStateRaw: "persistence:read-workspace-state-raw",
  persistenceWriteWorkspaceStateRaw: "persistence:write-workspace-state-raw",
  persistenceReadAppState: "persistence:read-app-state",
  persistenceWriteAppState: "persistence:write-app-state",
  persistenceReadRoomCanvasState: "persistence:read-room-canvas-state",
  persistenceWriteRoomCanvasState: "persistence:write-room-canvas-state",
  persistenceReadWorkspaceAgentReadState:
    "persistence:read-workspace-agent-read-state",
  persistenceWriteWorkspaceAgentReadState:
    "persistence:write-workspace-agent-read-state",
  persistenceReadNodeScrollback: "persistence:read-node-scrollback",
  persistenceWriteNodeScrollback: "persistence:write-node-scrollback",
  persistenceReadAgentNodePlaceholderScrollback:
    "persistence:read-agent-node-placeholder-scrollback",
  persistenceWriteAgentNodePlaceholderScrollback:
    "persistence:write-agent-node-placeholder-scrollback",
  syncStateUpdated: "sync:state-updated",
  appUpdateGetState: "app-update:get-state",
  appUpdateConfigure: "app-update:configure",
  appUpdateCheck: "app-update:check",
  appUpdateDownload: "app-update:download",
  appUpdateInstall: "app-update:install",
  appUpdateState: "app-update:state",
  windowChromeSetTheme: "window-chrome:set-theme",
  windowChromeCloseCurrentWindow: "window-chrome:close-current-window",
  /** Main BrowserWindow: push { compactTitlebar } for macOS hidden titlebar layout tweaks. */
  shellHostWindowLayout: "shell:host-window-layout",
  /** Renderer → main: align traffic lights to measured workspace top row (macOS). */
  shellHostDarwinTrafficLightsLayout: "shell:host-darwin-traffic-lights-layout",
  shellDarwinNativeTrafficLightsVisible:
    "shell:darwin-native-traffic-lights-visible",
  shellHostWindowMinimize: "shell:host-window-minimize",
  shellHostWindowToggleMaximize: "shell:host-window-toggle-maximize",
  shellHostWindowClose: "shell:host-window-close",
  windowMetricsGetDisplayInfo: "window-metrics:get-display-info",
  websiteWindowPrepareSession: "website-window:prepare-session",
  websiteWindowRegisterGuest: "website-window:register-guest",
  websiteWindowGuestOpenUrl: "website-window:guest-open-url",
  websiteWindowUnregisterGuest: "website-window:unregister-guest",
  websiteWindowSetOccluded: "website-window:set-occluded",
  websiteWindowActivate: "website-window:activate",
  websiteWindowNavigate: "website-window:navigate",
  websiteWindowGoBack: "website-window:go-back",
  websiteWindowGoForward: "website-window:go-forward",
  websiteWindowReload: "website-window:reload",
  websiteWindowClose: "website-window:close",
  websiteWindowDebugDump: "website-window:debug-dump",
  websiteWindowBridgeCall: "website-window-bridge:call",
  websiteWindowDebugConsoleSetEnabled:
    "website-window:debug-console-set-enabled",
  websiteWindowEvent: "website-window:event",
  terminalDiagnosticsLog: "terminal:diagnostics-log",
  runtimeDiagnosticsLog: "runtime:diagnostics-log",
  debugWindowIpcInspectorAppendRecord:
    "debug-window:ipc-inspector-append-record",
  debugWindowIpcInspectorListRecords: "debug-window:ipc-inspector-list-records",
  debugWindowIpcInspectorClearRecords:
    "debug-window:ipc-inspector-clear-records",
  debugWindowIpcInspectorExportRecords:
    "debug-window:ipc-inspector-export-records",
  debugWindowIpcInspectorRecordsUpdated:
    "debug-window:ipc-inspector-records-updated",
  debugWindowGetPinned: "debug-window:get-pinned",
  debugWindowSetPinned: "debug-window:set-pinned",
  agentListModels: "agent:list-models",
  agentListInstalledProviders: "agent:list-installed-providers",
  systemListFonts: "system:list-fonts",
  systemExportLogs: "system:export-logs",
  systemGetLogsSummary: "system:get-logs-summary",
  systemClearLogs: "system:clear-logs",
  systemGetDoctorCliInstallState: "system:get-doctor-cli-install-state",
  systemInstallDoctorCli: "system:install-doctor-cli"
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
