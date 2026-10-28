export interface TerminalCliVersion {
  version: string;
  commit: string | null;
}

export type TerminalCliVersionState = "not_installed" | "current" | "update_available" | "different" | "newer" | "unknown";

export interface TerminalCliSource {
  kind: "development" | "packaged";
  appPath: string;
  cliPath: string;
}

export interface TerminalCliStatus {
  supported: boolean;
  bundleAvailable: boolean;
  installed: boolean;
  managed: boolean;
  commandPath: string;
  conflictPath: string | null;
  shellFiles: string[];
  detectedPath: string | null;
  currentVersion: TerminalCliVersion | null;
  bundledVersion: TerminalCliVersion | null;
  versionState: TerminalCliVersionState;
  source: TerminalCliSource;
  bindingState: "current" | "other" | "unmanaged" | "missing";
}

export type TerminalCliErrorCode = "unsupported" | "bundle_missing" | "conflict" | "shell_conflict" | "filesystem";
export type TerminalCliResult =
  | { ok: true; status: TerminalCliStatus }
  | { ok: false; error: TerminalCliErrorCode };

export interface TerminalCliClient {
  status(): Promise<TerminalCliStatus>;
  install(): Promise<TerminalCliResult>;
  uninstall(): Promise<TerminalCliResult>;
}
